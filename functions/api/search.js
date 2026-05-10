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

    // ── 1. SCRAPE SHERIFF SALES — POST with Status=Open ────────────────────
    if (type === "scrape") {
      const { countyId } = body;

      // CivilView needs a form POST to return results
      const formData = new URLSearchParams({
        countyId: String(countyId),
        Status: "Open",
        SaleMonth: "",
        SaleDate: "",
        Sheriff: "",
        Plaintiff: "",
        Defendant: "",
        Address: "",
        City: "",
      });

      const res = await fetch("https://salesweb.civilview.com/Sales/SalesSearch", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Referer": `https://salesweb.civilview.com/Sales/SalesSearch?countyId=${countyId}`,
          "Origin": "https://salesweb.civilview.com",
        },
        body: formData.toString(),
      });

      if (!res.ok) throw new Error(`CivilView error: ${res.status}`);
      const html = await res.text();

      const properties = [];
      const clean = (s) => (s || "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

      // Parse table rows — each row has: Sheriff#, Sale Date, Plaintiff, Defendant, Address, City
      const rowRegex = /<tr[^>]*class="[^"]*(?:row|item|sale)[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
      let rowMatch;
      while ((rowMatch = rowRegex.exec(html)) !== null) {
        const row = rowMatch[1];
        const propIdMatch = row.match(/PropertyId=(\d+)/i);
        if (!propIdMatch) continue;

        const cells = [];
        const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        let cell;
        while ((cell = cellRegex.exec(row)) !== null) {
          cells.push(clean(cell[1]));
        }

        if (cells.length >= 5) {
          properties.push({
            propertyId: propIdMatch[1],
            sheriffNum:  cells[0] || "",
            saleDate:    cells[1] || "",
            plaintiff:   cells[2] || "",
            defendant:   cells[3] || "",
            address:     cells[4] || "",
            city:        cells[5] || "",
          });
        }
      }

      // Fallback: try simpler row detection if class-based didn't match
      if (properties.length === 0) {
        const allRows = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
        for (const rawRow of allRows) {
          const propIdMatch = rawRow.match(/PropertyId=(\d+)/i);
          if (!propIdMatch) continue;
          const cells = [];
          const cellRegex2 = /<td[^>]*>([\s\S]*?)<\/td>/gi;
          let c2;
          while ((c2 = cellRegex2.exec(rawRow)) !== null) {
            cells.push(clean(c2[1]));
          }
          if (cells.length >= 4) {
            properties.push({
              propertyId: propIdMatch[1],
              sheriffNum:  cells[0] || "",
              saleDate:    cells[1] || "",
              plaintiff:   cells[2] || "",
              defendant:   cells[3] || "",
              address:     cells[4] || "",
              city:        cells[5] || "",
            });
          }
        }
      }

      // Also try to get property details URL for each listing
      const detailLinks = {};
      const linkRegex = /href="[^"]*SaleDetails[^"]*PropertyId=(\d+)[^"]*"/gi;
      let lm;
      while ((lm = linkRegex.exec(html)) !== null) {
        detailLinks[lm[1]] = `https://salesweb.civilview.com/Sales/SaleDetails?PropertyId=${lm[1]}`;
      }

      return new Response(JSON.stringify({ properties, total: properties.length, detailLinks }), {
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    // ── 2. GET FULL PROPERTY DETAILS FROM CIVILVIEW ─────────────────────────
    if (type === "details") {
      const { propertyId } = body;
      const url = `https://salesweb.civilview.com/Sales/SaleDetails?PropertyId=${propertyId}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html" }
      });
      if (!res.ok) throw new Error(`Details fetch failed: ${res.status}`);
      const html = await res.text();
      const clean = (s) => (s || "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

      // Parse detail fields — CivilView uses label/value pairs in a table
      const details = {};
      const pairRegex = /<td[^>]*class="[^"]*label[^"]*"[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
      let pm;
      while ((pm = pairRegex.exec(html)) !== null) {
        const key = clean(pm[1]).replace(/:$/, "").trim();
        const val = clean(pm[2]).trim();
        if (key && val) details[key] = val;
      }

      // Also try th/td pairs
      const thRegex = /<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
      let th;
      while ((th = thRegex.exec(html)) !== null) {
        const key = clean(th[1]).replace(/:$/, "").trim();
        const val = clean(th[2]).trim();
        if (key && val) details[key] = val;
      }

      return new Response(JSON.stringify({ details, url }), {
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    // ── 3. COMPS FROM NJPARCELS ─────────────────────────────────────────────
    if (type === "comps") {
      const { address, city, county } = body;
      const fullAddr = city ? `${address}, ${city}` : address;
      const streetAddr = address.replace(/,.*$/, "").trim();
      const searchUrl = `https://njparcels.com/search/address/?s=${encodeURIComponent(streetAddr)}&s_co=`;

      const searchRes = await fetch(searchUrl, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html" }
      });
      if (!searchRes.ok) throw new Error(`NJParcels search failed: ${searchRes.status}`);
      const searchHtml = await searchRes.text();

      let parcelId = null;
      let foundAddress = null;
      const rowsRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let rowM;
      while ((rowM = rowsRegex.exec(searchHtml)) !== null) {
        const row = rowM[1];
        if (!row.includes("comparable")) continue;
        if (county && !row.toLowerCase().includes(county.toLowerCase())) continue;
        const parcelMatch = row.match(/\/sales\/comparable\/([^"'\s]+)/);
        const addrMatch = row.match(/\/property\/[^>]+>([^<]+)</);
        if (parcelMatch) {
          parcelId = parcelMatch[1];
          foundAddress = addrMatch ? addrMatch[1].trim() : streetAddr;
          break;
        }
      }

      if (!parcelId) {
        return new Response(JSON.stringify({ comps: null, searchUrl, message: "No match found on NJParcels." }), {
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
        if (cells.length >= 3 && (cells[2] || "").includes("$")) {
          sales.push({ address: cells[0] || "", date: cells[1] || "", price: cells[2] || "", assessment: cells[3] || "", sqft: cells[4] || "", ppsf: cells[5] || "" });
        }
      }

      return new Response(JSON.stringify({ comps: sales, foundAddress, parcelId, compsUrl, salesUrl, searchUrl }), {
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    // ── 4. FULL LIEN CHECK ──────────────────────────────────────────────────
    if (type === "liens") {
      const { address, city, county, plaintiff, defendant, sheriffNum, parcelId } = body;

      const countyClerkUrls = {
        "Atlantic":"http://atlantic.newvisionsystems.com/ClerkSearch/",
        "Bergen":"https://landrecords.bergencountyclerk.gov/LandRecords/",
        "Burlington":"http://press.co.burlington.nj.us",
        "Camden":"http://camden.newvisionsystems.com/clerksearch/",
        "Cape May":"http://clerk.capemaycountynj.gov/landrecords/",
        "Cumberland":"https://www.cumberlandcountynj.gov/county-clerk",
        "Essex":"https://press.essexregister.com/prodpress/index.aspx",
        "Gloucester":"https://gcclerk.com/land-records/",
        "Hudson":"https://clerkrecords.hcnj.us/",
        "Hunterdon":"https://clerk.co.hunterdon.nj.us/clerkrecords/",
        "Mercer":"http://records.mercercounty.org",
        "Middlesex":"https://mcrecords.co.middlesex.nj.us/recordssearch/",
        "Monmouth":"http://oprs.co.monmouth.nj.us/oprs/clerk/ClerkHome.aspx",
        "Morris":"https://mcclerksearch.co.morris.nj.us/",
        "Ocean":"https://sng.co.ocean.nj.us/publicsearch/",
        "Passaic":"http://records.passaiccountynj.org",
        "Salem":"https://salemcountynj.gov/county-clerk/",
        "Somerset":"https://liveacclaim.co.somerset.nj.us/AcclaimWeb/",
        "Sussex":"https://sussexclerk.org/land-records/",
        "Union":"https://unioncountynj.gov/county-clerk/",
        "Warren":"https://warrencountynj.gov/county-clerk/land-records/",
      };

      const taxUrls = {
        "Atlantic":"https://www.aclink.org/taxcollector/","Bergen":"https://www.co.bergen.nj.us/tax-collector",
        "Burlington":"https://www.co.burlington.nj.us/tax-collector","Camden":"https://camdencountynj.gov/tax-collector",
        "Cape May":"https://capemaycountynj.gov/tax-collector","Cumberland":"https://www.cumberlandcountynj.gov/tax-collector",
        "Essex":"https://www.essexcountynj.org/tax-collector","Gloucester":"https://www.gloucestercountynj.gov/tax-collector",
        "Hudson":"https://hudsoncountynj.gov/tax-collector","Hunterdon":"https://www.co.hunterdon.nj.us/tax-collector",
        "Mercer":"https://www.mercercounty.org/tax-collector","Middlesex":"https://www.middlesexcountynj.gov/tax-collector",
        "Monmouth":"https://www.co.monmouth.nj.us/tax-collector","Morris":"https://www.morriscountynj.gov/tax-collector",
        "Ocean":"https://www.co.ocean.nj.us/tax-collector","Passaic":"https://www.passaiccountynj.org/tax-collector",
        "Salem":"https://www.salemcountynj.gov/tax-collector","Somerset":"https://www.co.somerset.nj.us/tax-collector",
        "Sussex":"https://www.sussexcountynj.org/tax-collector","Union":"https://ucnj.org/tax-collector",
        "Warren":"https://warrencountynj.gov/tax-collector",
      };

      const clerkUrl = countyClerkUrls[county] || "https://www.nj.gov/state/archives/catcounty.html";
      const taxUrl = taxUrls[county] || "";
      const njParcelsUrl = parcelId
        ? `https://njparcels.com/property/${parcelId.replace(/_/g,"/")}`
        : `https://njparcels.com/search/address/?s=${encodeURIComponent((address||"").replace(/,.*$/,"").trim())}`;

      const prompt = `You are a NJ real estate title analyst. Give a SPECIFIC lien risk assessment for this Sheriff Sale property.

Address: ${address}${city ? ", " + city : ""}
County: ${county} County, NJ
Sheriff #: ${sheriffNum}
Defendant: ${defendant}
Plaintiff (Foreclosing Lender): ${plaintiff}

Provide a SPECIFIC analysis with these exact sections:

RISK LEVEL: [Choose exactly one: LOW / MEDIUM / HIGH] — then explain the specific reason in 1 sentence based on the plaintiff type and typical ${county} County foreclosures.

PLAINTIFF ANALYSIS: What type of lender is "${plaintiff}"? Is this a bank, servicer, HOA, or government? What does this tell us about how long the foreclosure has been going on and what other liens likely exist?

LIKELY LIENS: List the 3 most probable specific liens on this property with estimated dollar amounts based on ${county} County averages:
- [Lien type]: $[estimated amount] — [reason]
- [Lien type]: $[estimated amount] — [reason]  
- [Lien type]: $[estimated amount] — [reason]

ESTIMATED TOTAL LIEN EXPOSURE: $[total estimated amount beyond the mortgage]

TAX DELINQUENCY: Based on ${county} County average property taxes and typical foreclosure timeline, estimate outstanding taxes in dollars.

BANKRUPTCY CHECK: How to search if "${defendant}" filed bankruptcy and why it matters.

RED FLAGS: Any specific red flags based on plaintiff "${plaintiff}" and ${county} County.

Be specific with dollar amounts. Do not use asterisks.`;

      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 1200 },
          }),
        }
      );
      const gData = await geminiRes.json();
      if (!geminiRes.ok) throw new Error(gData?.error?.message || "Gemini error");
      const analysis = (gData?.candidates?.[0]?.content?.parts?.[0]?.text || "").replace(/\*+/g, "").trim();

      return new Response(JSON.stringify({
        analysis,
        links: {
          njCourts: { url: "https://portal.njcourts.gov/webe40/JudgmentWeb/jsp/judgmentSearch.faces", label: "NJ Courts — Judgment Search", desc: `Search statewide judgments against "${defendant}"` },
          countyClerk: { url: clerkUrl, label: `${county} County Clerk — Land Records`, desc: "Deeds, mortgages, tax sale certificates, HOA liens" },
          njParcels: { url: njParcelsUrl, label: "NJParcels — Tax & Assessment", desc: "Property tax history and assessment records" },
          taxCollector: { url: taxUrl, label: `${county} County Tax Collector`, desc: "Outstanding property tax delinquency" },
          pacer: { url: "https://pacer.gov", label: "PACER — Federal Bankruptcy", desc: `Check bankruptcy filings by "${defendant}"` },
          njBankruptcy: { url: "https://www.njb.uscourts.gov/", label: "NJ Bankruptcy Court", desc: "NJ District bankruptcy filings" },
        },
        defendant, county,
      }), { headers: { "Content-Type": "application/json", ...cors } });
    }

    throw new Error("Invalid request type");

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}
