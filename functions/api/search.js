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

    // ── 1. SCRAPE SHERIFF SALES ─────────────────────────────────────────────
    if (type === "scrape") {
      const { countyId } = body;
      const res = await fetch(
        `https://salesweb.civilview.com/Sales/SalesSearch?countyId=${countyId}`,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        }
      );
      if (!res.ok) throw new Error(`CivilView error: ${res.status}`);
      const html = await res.text();

      const properties = [];
      const clean = (s) => (s || "")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      // Parse every table row that contains a PropertyId link
      const allRows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
      for (const row of allRows) {
        if (!row.includes("PropertyId=")) continue;

        const propIdMatch = row.match(/PropertyId=(\d+)/i);
        if (!propIdMatch) continue;

        // Extract all cell contents
        const cells = [];
        const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        let cm;
        while ((cm = cellRegex.exec(row)) !== null) {
          cells.push(clean(cm[1]));
        }

        // CivilView columns: [View Details link], Sheriff#, Sale Date, Plaintiff, Defendant, Address
        // The first cell is the "View Details" link cell — skip it
        // So cells[1]=Sheriff#, cells[2]=SaleDate, cells[3]=Plaintiff, cells[4]=Defendant, cells[5]=Address
        if (cells.length >= 5) {
          // Parse address — last part after last comma is city+state+zip
          const rawAddr = cells[5] || cells[4] || "";
          let address = rawAddr;
          let city = "";

          // CivilView format: "123 MAIN ST TOMS RIVER NJ 08753"
          // Extract city by finding NJ zip pattern
          const cityMatch = rawAddr.match(/^(.*?)\s+([A-Z\s]+)\s+NJ\s+\d{5}/i);
          if (cityMatch) {
            address = cityMatch[1].trim();
            city = cityMatch[2].trim();
          } else {
            // Try splitting on last comma
            const parts = rawAddr.split(/,\s*/);
            if (parts.length > 1) {
              address = parts.slice(0, -1).join(", ");
              city = parts[parts.length - 1].replace(/\s*NJ\s*\d{5}.*$/i, "").trim();
            }
          }

          properties.push({
            propertyId: propIdMatch[1],
            sheriffNum:  cells[1] || "",
            saleDate:    cells[2] || "",
            plaintiff:   cells[3] || "",
            defendant:   cells[4] || "",
            address:     address || rawAddr,
            city:        city,
            fullAddress: rawAddr,
          });
        }
      }

      return new Response(JSON.stringify({ properties, total: properties.length }), {
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    // ── 2. GET FULL PROPERTY DETAILS ────────────────────────────────────────
    if (type === "details") {
      const { propertyId } = body;
      const res = await fetch(
        `https://salesweb.civilview.com/Sales/SaleDetails?PropertyId=${propertyId}`,
        { headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html" } }
      );
      if (!res.ok) throw new Error(`Details fetch failed: ${res.status}`);
      const html = await res.text();

      const clean = (s) => (s || "")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      const details = {};

      // Try label:value td pairs
      const pairRegex = /<td[^>]*class="[^"]*[Ll]abel[^"]*"[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
      let pm;
      while ((pm = pairRegex.exec(html)) !== null) {
        const k = clean(pm[1]).replace(/:$/, "").trim();
        const v = clean(pm[2]).trim();
        if (k && v) details[k] = v;
      }

      // Try th/td pairs
      const thRegex = /<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
      let th;
      while ((th = thRegex.exec(html)) !== null) {
        const k = clean(th[1]).replace(/:$/, "").trim();
        const v = clean(th[2]).trim();
        if (k && v && !details[k]) details[k] = v;
      }

      // Also try any bold/strong label pattern
      const boldRegex = /<(?:b|strong)[^>]*>([\s\S]*?)<\/(?:b|strong)>\s*:?\s*([\s\S]*?)(?=<(?:b|strong|br|p|div|tr))/g;
      let bm;
      while ((bm = boldRegex.exec(html)) !== null) {
        const k = clean(bm[1]).replace(/:$/, "").trim();
        const v = clean(bm[2]).trim();
        if (k && v && k.length < 50 && !details[k]) details[k] = v;
      }

      return new Response(JSON.stringify({ details, url: `https://salesweb.civilview.com/Sales/SaleDetails?PropertyId=${propertyId}` }), {
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    // ── 3. COMPS FROM NJPARCELS ─────────────────────────────────────────────
    if (type === "comps") {
      const { address, city, county } = body;
      const streetAddr = (address || "").replace(/,.*$/, "").trim();
      const searchUrl = `https://njparcels.com/search/address/?s=${encodeURIComponent(streetAddr)}&s_co=`;

      const searchRes = await fetch(searchUrl, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html" }
      });
      if (!searchRes.ok) throw new Error(`NJParcels search failed: ${searchRes.status}`);
      const searchHtml = await searchRes.text();

      let parcelId = null, foundAddress = null;
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
      const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let tRow;
      while ((tRow = trRegex.exec(compsHtml)) !== null) {
        const row = tRow[1];
        const cells = [];
        const cRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        let cMatch;
        while ((cMatch = cRegex.exec(row)) !== null) {
          cells.push(cMatch[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
        }
        if (cells.length >= 3 && (cells[2] || "").includes("$")) {
          sales.push({
            address: cells[0] || "",
            date: cells[1] || "",
            price: cells[2] || "",
            assessment: cells[3] || "",
            sqft: cells[4] || "",
            ppsf: cells[5] || "",
          });
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
        ? `https://njparcels.com/property/${parcelId.replace(/_/g, "/")}`
        : `https://njparcels.com/search/address/?s=${encodeURIComponent((address || "").replace(/,.*$/, "").trim())}`;

      const fullAddr = `${address}${city ? ", " + city : ""}, NJ`;

      const prompt = `You are a NJ real estate title analyst. Give a SPECIFIC lien risk assessment for this Sheriff Sale property.

Address: ${fullAddr}
County: ${county} County, NJ
Sheriff #: ${sheriffNum}
Defendant: ${defendant}
Plaintiff (Foreclosing Lender): ${plaintiff}

RISK LEVEL: Rate as LOW, MEDIUM, or HIGH based on these factors — HOA liens = higher risk, big bank plaintiff = medium, private lender = higher, reverse mortgage = lower equity risk. Give 1 sentence reason.

PLAINTIFF ANALYSIS: What type of lender is "${plaintiff}"? How long has this likely been in foreclosure based on the lender type?

LIKELY LIENS: List 3 specific liens with realistic dollar estimates for ${county} County NJ:
- Property Taxes: $[estimate based on ${county} County avg of $8,000-$15,000/yr x estimated delinquency years]
- [Second most likely lien type]: $[amount]
- [Third most likely lien type]: $[amount]

ESTIMATED TOTAL ADDITIONAL LIEN EXPOSURE: $[total beyond the mortgage]

BANKRUPTCY RISK: Check PACER.gov for "${defendant}" — explain why this matters for this sale.

RED FLAGS: List 1-3 specific red flags for this property based on plaintiff "${plaintiff}" and ${county} County.

Keep it practical. No asterisks. Use real dollar estimates.`;

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
