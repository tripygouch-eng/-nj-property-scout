export async function onRequest(context) {
  const { request, env } = context;

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  try {
    const body = await request.json();
    const { type } = body;

    // ── 1. SCRAPE SHERIFF SALES FROM CIVILVIEW ─────────────────────────────
    if (type === "scrape") {
      const { countyId } = body;
      const res = await fetch(
        `https://salesweb.civilview.com/Sales/SalesSearch?countyId=${countyId}`,
        { headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html" } }
      );
      if (!res.ok) throw new Error(`CivilView fetch failed: ${res.status}`);
      const html = await res.text();

      const properties = [];
      const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let rowMatch;
      while ((rowMatch = rowRegex.exec(html)) !== null) {
        const row = rowMatch[1];
        if (!row.includes("PropertyId=")) continue;
        const propIdMatch = row.match(/PropertyId=(\d+)/);
        const cells = [];
        const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        let cellMatch;
        while ((cellMatch = cellRegex.exec(row)) !== null) {
          cells.push(cellMatch[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim());
        }
        if (propIdMatch && cells.length >= 5) {
          properties.push({
            propertyId: propIdMatch[1],
            sheriffNum: cells[0] || "",
            saleDate: cells[1] || "",
            plaintiff: cells[2] || "",
            defendant: cells[3] || "",
            address: cells[4] || "",
          });
        }
      }

      return new Response(JSON.stringify({ properties, total: properties.length }), {
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    // ── 2. COMPS FROM NJPARCELS ─────────────────────────────────────────────
    if (type === "comps") {
      const { address, county } = body;
      const streetAddr = address.replace(/,.*$/, "").trim();
      const searchUrl = `https://njparcels.com/search/address/?s=${encodeURIComponent(streetAddr)}&s_co=`;

      const searchRes = await fetch(searchUrl, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html" }
      });
      if (!searchRes.ok) throw new Error(`NJParcels search failed: ${searchRes.status}`);
      const searchHtml = await searchRes.text();

      const rowsRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let parcelId = null;
      let foundAddress = null;
      let rowM;
      while ((rowM = rowsRegex.exec(searchHtml)) !== null) {
        const row = rowM[1];
        if (!row.includes("njparcels.com/sales/comparable/")) continue;
        if (!row.toLowerCase().includes(county.toLowerCase())) continue;
        const parcelMatch = row.match(/\/sales\/comparable\/([^"'\s]+)/);
        const addrMatch = row.match(/\/property\/[^>]+>([^<]+)</);
        if (parcelMatch) {
          parcelId = parcelMatch[1];
          foundAddress = addrMatch ? addrMatch[1].trim() : streetAddr;
          break;
        }
      }

      if (!parcelId) {
        return new Response(JSON.stringify({ comps: null, searchUrl, message: "No exact match found." }), {
          headers: { "Content-Type": "application/json", ...cors },
        });
      }

      const compsUrl = `https://njparcels.com/sales/comparable/${parcelId}`;
      const salesUrl = `https://njparcels.com/sales/${parcelId}`;
      const compsRes = await fetch(compsUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!compsRes.ok) throw new Error(`Comps fetch failed: ${compsRes.status}`);
      const compsHtml = await compsRes.text();

      const sales = [];
      const tableRowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let tRow;
      while ((tRow = tableRowRegex.exec(compsHtml)) !== null) {
        const row = tRow[1];
        const cells = [];
        const cRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        let cMatch;
        while ((cMatch = cRegex.exec(row)) !== null) {
          cells.push(cMatch[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
        }
        if (cells.length >= 3 && cells[2] && cells[2].includes("$")) {
          sales.push({ address: cells[0] || "", date: cells[1] || "", price: cells[2] || "", assessment: cells[3] || "" });
        }
      }

      return new Response(JSON.stringify({ comps: sales, foundAddress, parcelId, compsUrl, salesUrl, searchUrl }), {
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    // ── 3. FULL LIEN CHECK — NJ Courts + County Clerk + NJParcels + AI ──────
    if (type === "liens") {
      const { address, county, plaintiff, defendant, sheriffNum, parcelId } = body;

      // County clerk URLs for all 21 NJ counties
      const countyClerkUrls = {
        "Atlantic":   "http://atlantic.newvisionsystems.com/ClerkSearch/",
        "Bergen":     "https://landrecords.bergencountyclerk.gov/LandRecords/",
        "Burlington": "http://press.co.burlington.nj.us",
        "Camden":     "http://camden.newvisionsystems.com/clerksearch/",
        "Cape May":   "http://clerk.capemaycountynj.gov/landrecords/",
        "Cumberland": "https://www.cumberlandcountynj.gov/county-clerk",
        "Essex":      "https://press.essexregister.com/prodpress/index.aspx",
        "Gloucester": "https://gcclerk.com/land-records/",
        "Hudson":     "https://clerkrecords.hcnj.us/",
        "Hunterdon":  "https://clerk.co.hunterdon.nj.us/clerkrecords/",
        "Mercer":     "http://records.mercercounty.org",
        "Middlesex":  "https://mcrecords.co.middlesex.nj.us/recordssearch/",
        "Monmouth":   "http://oprs.co.monmouth.nj.us/oprs/clerk/ClerkHome.aspx?op=basic",
        "Morris":     "https://mcclerksearch.co.morris.nj.us/",
        "Ocean":      "https://sng.co.ocean.nj.us/publicsearch/",
        "Passaic":    "http://records.passaiccountynj.org",
        "Salem":      "https://salemcountynj.gov/county-clerk/",
        "Somerset":   "https://liveacclaim.co.somerset.nj.us/AcclaimWeb/",
        "Sussex":     "https://sussexclerk.org/land-records/",
        "Union":      "https://unioncountynj.gov/county-clerk/",
        "Warren":     "https://warrencountynj.gov/county-clerk/land-records/",
      };

      const clerkUrl = countyClerkUrls[county] || "https://www.nj.gov/state/archives/catcounty.html";

      // NJ Courts judgment search — deep link with defendant name
      const defName = encodeURIComponent(defendant || "");
      const njCourtsUrl = `https://portal.njcourts.gov/webe40/JudgmentWeb/jsp/judgmentSearch.faces`;

      // NJParcels tax record link
      const njParcelsUrl = parcelId
        ? `https://njparcels.com/property/${parcelId.replace(/_/g, "/")}`
        : `https://njparcels.com/search/address/?s=${encodeURIComponent(address.replace(/,.*$/, "").trim())}`;

      // Tax delinquency search for the county
      const taxUrls = {
        "Atlantic":   "https://www.aclink.org/taxcollector/",
        "Bergen":     "https://www.co.bergen.nj.us/tax-collector",
        "Burlington": "https://www.co.burlington.nj.us/tax-collector",
        "Camden":     "https://camdencountynj.gov/tax-collector",
        "Cape May":   "https://capemaycountynj.gov/tax-collector",
        "Cumberland": "https://www.cumberlandcountynj.gov/tax-collector",
        "Essex":      "https://www.essexcountynj.org/tax-collector",
        "Gloucester": "https://www.gloucestercountynj.gov/tax-collector",
        "Hudson":     "https://hudsoncountynj.gov/tax-collector",
        "Hunterdon":  "https://www.co.hunterdon.nj.us/tax-collector",
        "Mercer":     "https://www.mercercounty.org/tax-collector",
        "Middlesex":  "https://www.middlesexcountynj.gov/tax-collector",
        "Monmouth":   "https://www.co.monmouth.nj.us/tax-collector",
        "Morris":     "https://www.morriscountynj.gov/tax-collector",
        "Ocean":      "https://www.co.ocean.nj.us/tax-collector",
        "Passaic":    "https://www.passaiccountynj.org/tax-collector",
        "Salem":      "https://www.salemcountynj.gov/tax-collector",
        "Somerset":   "https://www.co.somerset.nj.us/tax-collector",
        "Sussex":     "https://www.sussexcountynj.org/tax-collector",
        "Union":      "https://ucnj.org/tax-collector",
        "Warren":     "https://warrencountynj.gov/tax-collector",
      };

      const taxUrl = taxUrls[county] || "";

      // Ask Gemini to analyze risk based on available info
      const prompt = `You are a NJ real estate title analyst. Analyze lien risk for this Sheriff Sale property and give a concise risk assessment.

Property: ${address}
County: ${county} County, NJ
Sheriff #: ${sheriffNum}
Defendant (Property Owner): ${defendant}
Plaintiff (Foreclosing Lender): ${plaintiff}

Based on this information provide:

1. LIEN RISK LEVEL: Rate as LOW / MEDIUM / HIGH and explain why in 1-2 sentences
2. PLAINTIFF ANALYSIS: What type of lender is "${plaintiff}"? What does this tell us about the foreclosure?
3. COMMON LIENS TO EXPECT: List the 3 most likely additional liens on this type of NJ foreclosure property
4. TAX DELINQUENCY: Estimate typical property tax delinquency on a ${county} County foreclosure at Sheriff Sale
5. BANKRUPTCY RISK: How to check if "${defendant}" has filed bankruptcy (include PACER.gov)
6. RED FLAGS: Any red flags based on the available information

Keep it concise and practical. No asterisks. Numbered list format.`;

      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 1000 },
          }),
        }
      );
      const gData = await geminiRes.json();
      if (!geminiRes.ok) throw new Error(gData?.error?.message || "Gemini error");
      const analysis = gData?.candidates?.[0]?.content?.parts?.[0]?.text?.replace(/\*+/g, "").trim() || "";

      return new Response(JSON.stringify({
        analysis,
        links: {
          njCourts: { url: njCourtsUrl, label: "NJ Courts — Judgment Search", desc: "Search statewide judgments by defendant name (1984–present)" },
          countyClerk: { url: clerkUrl, label: `${county} County Clerk — Land Records`, desc: "Search deeds, mortgages, tax sale certificates, HOA liens" },
          njParcels: { url: njParcelsUrl, label: "NJParcels — Tax & Assessment Records", desc: "View property tax history and assessment data" },
          taxCollector: { url: taxUrl, label: `${county} County Tax Collector`, desc: "Check for outstanding property tax delinquency" },
          pacer: { url: "https://pacer.gov", label: "PACER — Federal Bankruptcy Search", desc: `Check if ${defendant} has filed for bankruptcy protection` },
          njBankruptcy: { url: "https://www.njb.uscourts.gov/", label: "NJ Bankruptcy Court", desc: "NJ District bankruptcy filings" },
        },
        defendant,
        county,
      }), {
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    throw new Error("Invalid request type");

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}
