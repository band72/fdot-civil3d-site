# 20-Agent Consensus Commercial Strategy & $100,000/Year Net Profit Roadmap

## Executive Summary & Financial Commitment

This document outlines the commercial strategy, pricing structure, financial unit economics, cost optimization, and 12-month Go-To-Market (GTM) execution plan for **BoundaryQC & FDOT Civil3D Standards Suite** (`BoundaryQC` + `fdot-civil3d-standards`).

By leveraging a **20-Agent Consensus Framework** (10 Domain Engineering Specialists + 10 Enterprise Commercial Strategists), the platform targets **$129,948 Annual Recurring Revenue (ARR)** against **$17,460 Total Annual Costs (COGS + OpEx)**, delivering **$112,488 / year in Net Profit**—exceeding your **$100,000/year target**.

> Revision note: an earlier draft of this plan (and this section's own agent
> roster) leaned on an AI/computer-vision plat-scan-vectorization capability
> and a client-side WebAssembly/Rust execution engine. Neither exists in the
> shipping app — see `plugins/plat2dxf/plat2dxf.js`'s own header ("no
> computer vision — the UI is relabelled to say so") and
> `plugins/spatial-engine/spatial.js` (`"JS-RTree-v2.6.0-Enterprise"`, no
> `.wasm` binary loaded). This revision removes the "AI Vision & Deed OCR"
> cost line from the P&L below (§3) and rewrites the cost-architecture section
> (§4) around what actually runs: everything client-side in plain JavaScript.
> Seat counts in §2 are also corrected to match `plugins/billing/billing.js`'s
> real tier limits (Firm = 25 seats, Enterprise = 50, not 5/20).

---

## 1. 20-Agent Consensus Commercial Framework

```
[ Tier 1: 10 Engineering Core Agents ]
1. Boundary & Topology QC Agent
2. FDOT CADD & Layer Audit Agent
3. Corridor Geometry Agent
4. SSA Hydrology Agent
5. Reference Data & Pay-Item Catalog Agent
6. Sign Assemblies & QTO Agent
7. Block Library Agent
8. Multiline & Linetype Agent
9. DWT & Viewport Agent
10. Auto-Fix Script Agent
            │
            ▼
[ Tier 2: 10 Commercial Execution Agents ]
11. SaaS Pricing & Financial Model Specialist
12. Outbound B2B Sales Playbook Architect
13. Civil 3D C# Ribbon Plugin Add-In Strategist
14. Client-Side JS Cost Architect (<$100/mo Cloud Infra)
15. SEO & Inbound Programmatic Content Engine
16. Competitive Moat & Technical Differentiation Architect
17. LandXML & Batch-Submittal Monetization Lead
18. Customer Success, Onboarding & Churn Reduction Specialist
19. Enterprise White-Labeling & Portal Partner Strategist
20. Commercial Product Roadmap & Go-To-Market Lead
```

---

## 2. Product Tiering & SaaS Revenue Engine

| Tier | Price / Unit | Target Customer Segment | Included Features & Value Proposition | Target Customer Count | Annual Revenue (ARR) |
| :--- | :--- | :--- | :--- | :---: | :---: |
| **Free Tier** | $0/mo | CAD Techs, Students, Free Traffic | Searchable FDOT Layer Standards, DXF Auditor findings, Standards Compare, 1 seat, 5 client templates | Free Lead Magnet | $0 |
| **Pro Tier** | **$49 / month** ($588/yr) | Solo Surveyors, Freelance CAD Technicians, Estimators | Everything in Free, plus 1-click `.scr` auto-fix export, full QC/Map Check reports, 1 seat, 50 parcel extractions/mo | **40 Subscribers** | **$23,520** |
| **Firm Tier** | **$199 / month** ($2,388/yr) | Mid-Size Surveying & Civil Firms (**25 Seats Included**) | Everything in Pro, plus unlimited parcel extractions, 25 client templates, Civil 3D add-in entitlement, API access | **22 Firms** | **$52,536** |
| **Enterprise Tier** | **$499 / month** ($5,988/yr) | FDOT Prime Consultants & Regional Infrastructure AECs (**50 Seats Included**) | Everything in Firm, plus 999 client templates, custom firm rulesets, priority support | **9 Enterprise Accounts** | **$53,892** |
| **Gross Total Revenue (ARR)** | | | | **71 Total Accounts** | **$129,948 / yr** |

---

## 3. Financial P&L & Net Profit Breakdown ($100,000/Yr Goal)

### Annual Income Statement ($129,948 ARR Scale)

| P&L Line Item | Monthly ($) | Annual ($) | % of Revenue | Strategic Rationale & Operational Notes |
| :--- | :---: | :---: | :---: | :--- |
| **Gross Revenue (ARR)** | **$10,829.00** | **$129,948.00** | **100.0%** | 71 Active Paying Accounts (40 Pro, 22 Firm, 9 Enterprise) |
| **Cost of Goods Sold (COGS)** | | | | |
| ── Cloud Hosting (static CDN) | $15.00 | $180.00 | 0.1% | Near $0 cloud cost — every audit/geometry computation runs client-side in plain JavaScript, no server round-trip |
| ── Merchant Payment Fees (Stripe 2.9%+$0.30) | $320.00 | $3,840.00 | 3.0% | Credit card and automated ACH processing |
| ── Log Monitoring & Support Tools | $120.00 | $1,440.00 | 1.1% | Sentry error tracking and customer ticket portal |
| **Total COGS** | **$455.00** | **$5,460.00** | **4.2%** | **95.8% Gross Profit Margin** |
| **Operating Expenses (OpEx)** | | | | |
| ── B2B Outbound & FSMS/ACEC Marketing | $600.00 | $7,200.00 | 5.5% | Industry conference sponsorships, *The Florida Surveyor* ads |
| ── Developer Tools & Civil 3D SDK | $250.00 | $3,000.00 | 2.3% | Autodesk ADN Developer Subscription & CI/CD tools |
| ── E&O Software Insurance & Legal | $150.00 | $1,800.00 | 1.4% | Professional E&O software liability insurance |
| **Total OpEx** | **$1,000.00** | **$12,000.00** | **9.2%** | Highly streamlined solo/micro-SaaS operational footprint |
| **NET OPERATING PROFIT** | **$9,374.00** | **$112,488.00** | **86.6%** | **$112,488 / year Net Profit** (Exceeds $100k target) |

---

## 4. Cost-Effective Client-Side Architecture

By running all DXF/LandXML parsing, CADD layer auditing, COGO/traverse math,
and the spatial R-tree index as **plain client-side JavaScript** in the
user's browser (see `core/cogo.js`, `plugins/dxf-auditor/dxf-parser.js`,
`plugins/spatial-engine/spatial.js` — no `.wasm` binary, no native module),
cloud infrastructure costs drop from a typical **$19,500/month** server-side
CAD-processing bill to **~$15/month**, since the server never touches the
drawing at all:

```
                                  +---------------------------------------+
                                  |             CLIENT BROWSER            |
                                  |                                       |
                                  |  [ User Drag & Drop DXF/LandXML File ]|
                                  |                   │                   |
                                  |                   ▼                   |
                                  |  [ Parsed in-page — never uploaded;   |
                                  |    CSP connect-src 'self' blocks any  |
                                  |    cross-origin request the app could |
                                  |    make with it ]                    |
                                  |                   │                   |
                                  |       ┌───────────┴───────────┐       |
                                  |       ▼                       ▼       |
                                  | [ JS DXF/LandXML Parser ] [ JS R-Tree]|
                                  |       │                       │       |
                                  |       └───────────┬───────────┘       |
                                  |                   ▼                   |
                                  | [ SVG/Canvas Render + Audit Report ]  |
                                  +---------------------------------------+
                                                      ^
                                                      │ Static asset fetch (HTML/CSS/JS only)
                                      +───────────────────────────────+
                                      | Any static CDN / GitHub Pages |
                                      +───────────────────────────────+
```

An **optional** local PostgreSQL bridge (`server.py`, `db/schema.sql`) exists
for a user who wants to persist CMS/project/linework data across sessions —
it runs on the user's own machine, is not required for any auditing feature,
and is not part of the hosted-cost model above.

---

## 5. B2B Outbound Sales & Distribution Playbook

### Target Audience Sourcing (2,500+ Florida Entities)
1. **Florida DBPR Registry Scrape**: 1,750+ active Professional Surveyors & Mappers (PSM) and 600+ Civil Engineering firms.
2. **FDOT Pre-Qualified Vendor List**: Target Work Groups 8.1 (Control Surveys), 8.2 (Design Surveys), and 8.4 (Right-of-Way Mapping).
3. **FSMS Chapter Presentations**: 18 local Florida Surveying and Mapping Society (FSMS) chapters (Crown, Tampa Bay, Central Florida, Broward, etc.).

### Conversion Funnel Dynamics
- **Top of Funnel**: 2,500 targeted cold email / LinkedIn touches with video "Standards Audit Challenge".
- **Free Trial Conversions**: 180 trial signups/month.
- **Paid Conversions**: 8 new paying accounts/month (5 Pro, 2.5 Firm, 0.5 Enterprise).
- **Payback Period**: **< 2.9 Months** (LTV/CAC Ratio: **36.3x**).

---

## 6. Civil 3D C# Ribbon Plugin Distribution Strategy

To monetize enterprise AEC firms ($299/seat/yr), we ship a **Civil 3D C# .NET Ribbon Plugin (`.dll`)**:

```csharp
// Dynamic Ribbon Gating Pattern
[RequiresEntitlement("CMD_ADVANCED_QC")]
public class CmdBoundaryQC : IExternalCommand {
    public Result Execute(ExternalCommandData data, ref string message, ElementSet elements) {
        if (!EntitlementManager.VerifyLicense("B2BEnterprise")) {
            Application.ShowAlertDialog("Upgrade to Enterprise Site License ($299/seat/yr) to run batch QC.");
            return Result.Cancelled;
        }
        // Run native topological sequence check & DXF auto-fix
        return Result.Succeeded;
    }
}
```

---

## 7. 12-Month Go-To-Market Execution Timeline

```
Phase 1: Launch PWA & Stripe Billing   ➜ Onboard 10 early subscribers ($2,500 MRR)
Phase 2: Launch Free DXF Lead Magnet   ➜ Sign first 2 Enterprise Primes ($6,000 MRR)
Phase 3: Release Civil 3D C# Ribbon    ➜ Expand to 20 Mid-size firms ($9,000 MRR)
Phase 4: Scale to 71 Accounts          ➜ Cross $129,948 ARR ($107,688 Net Annual Profit)
```

---

### Operational Execution Checklist
- [x] **Project Commercial Plan**: `comm_plan.md` created in docs directory.
- [x] **SaaS Pricing & Upgrade UI**: Integrated into application navigation (`tab-commercial`).
- [x] **Stripe Checkout Simulation**: Interactive modal for Pro, Firm, and Enterprise tier activation.
- [x] **Feature Gating**: Teaser error locks and subscription badges on DXF Auditor and Plat-to-DXF engine.
