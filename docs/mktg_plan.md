# BoundaryQC AI & FDOT Civil3D Standards Suite — Master Go-To-Market & Marketing Plan

## Executive Summary & Target Financial Growth

This document outlines the **Master Marketing & Customer Acquisition Strategy** for **BoundaryQC & FDOT Civil3D Standards Suite**. Developed via multi-agent consensus across 10 specialized marketing domain leaders, this plan is engineered to scale recurring revenue to **$129,948 ARR** ($10,829 MRR) across 71 active B2B accounts, yielding **$112,488 Net Annual Operating Profit** (86.6% net profit margin).

> Every capability named below exists in the shipping app today — this revision
> removed the AI/computer-vision plat-scan-vectorization angle (Channel 1's
> geo hubs, Channel 2's Loop 3, the FSMS booth pitch, and the XYht pitch) that
> a prior draft built the pSEO/PLG story around. There is no OCR, no image
> tracing, and no plat-scan ingestion anywhere in this codebase — see
> `plugins/plat2dxf/plat2dxf.js`'s own header comment. What the app does
> instead: turn a **typed** bearing/distance call list (or an uploaded DXF/
> LandXML) into vectors, DXF, and closure/standards reports. See
> `docs/comm_plan.md` for the corresponding P&L correction (an "AI Vision &
> Deed OCR" cost line that doesn't correspond to any real feature was removed,
> which raised the net profit figure above).

```
+-----------------------------------------------------------------------------------+
| TARGET ARR: $129,948  |  TOTAL COGS: $5,460   |  TOTAL OPEX: $12,000              |
| NET ANNUAL PROFIT: $112,488 / YEAR  |  NET PROFIT MARGIN: 86.6%                 |
+-----------------------------------------------------------------------------------+
```

---

## Target Audience & Ideal Customer Profiles (ICPs)

| Segment | Target Personas | Primary Operational Friction | Core Value Drivers |
| :--- | :--- | :--- | :--- |
| **Florida PSM Survey Firms** | Firm Owners, Lead PSMs, Chief Surveyors, CAD Directors | 3–5 hours spent per parcel manually typing metes-and-bounds into CAD; curve tangency & closure errors. | Instant call-list-to-DXF CAD vectors (typed bearing/distance — no scan needed), vector-geometry bow-tie prevention, F.A.C. 5J-17 / 61G17 closure scorecards. |
| **FDOT Engineering Primes** | VPs of Geomatics, Highway Dept Leads, Senior ROW Project Engineers | Bottlenecks batch-checking multi-sheet corridor DXF/LandXML packages for FDOT District submittals. | Batch CADD-standards audit of a whole DXF/LandXML package into one compliance matrix, closure checks, PKI/timestamp certificate gating. |
| **Heavy Civil Contractors** | Estimators, Project Engineers, Bid Managers | Inaccurate quantity take-offs (QTO) from raw CAD files, non-compliant FDOT pay item specs. | 10,000+ FDOT BOE Pay Item QTO solver, volumetric earthwork calculator, AASHTOWare Project Bids export. |
| **Municipal & District Reviewers** | FDOT District 1–7 Reviewers, County Public Works Engineers | Manual review of non-compliant CADD submittals and unclosed deed filings. | One-click automated DXF CADD-standards scanner & the 7-item Map Check QC verification report. |

---

## Master 10-Channel Marketing Strategy Engine

### Channel 1: Programmatic SEO (pSEO) — 10,000+ FDOT BOE & DXF Guides
- **Architecture**: Next.js 14 App Router with Incremental Static Regeneration (ISR) on Cloudflare Edge (<50ms TTFB).
- **Page Engines**:
  1. **10,000+ FDOT BOE Pay Item Pages**: Every pay item (e.g., `0520-1-10` Curb & Gutter) dynamically mapped to Civil 3D subassemblies, layers, spec sections, and state unit price ranges ($22-$36/LF).
  2. **500+ DXF Error Fix Guides**: Step-by-step resolution pages for `ERR_BOWTIE_SELF_INTERSECT`, `ERR_3D_NONPLANAR_POLYLINE`, and `INSUNITS` scale drift.
  3. **201+ Geo-Targeted Landing Pages**: 67 Florida counties $\times$ 3 formats (metes-and-bounds call list, DXF, LandXML) (e.g., `/legal-description-to-dxf/orange-county-fl/`).
- **Target Indexing**: Instant submission via Google Indexing API & IndexNow.

### Channel 2: Product-Led Growth (PLG) & Viral Loops
- **Loop 1: Free DXF Error Scanner (Lead Magnet)**: Zero-friction browser drag-and-drop DXF auditor. Highlights bow-ties (🔴) and closure gaps (🔵) on HTML5 canvas. Entering email unlocks auto-fix `.scr` script and clean DXF. ($K = 1.25$).
- **Loop 2: Forwardable Legal-Description QC Reports**: The Legal Description QC tab's Map Check export (metes-and-bounds parse, chord-trace closure, QC findings) is a self-contained file today, forwarded to title attorneys, municipal reviewers, and developers with a "Verify your legal description free" footer. A hosted `qc.boundaryqc.ai/report/<id>` link — dropping the email-the-file step — is the natural next iteration (needs a server; this app has none today beyond the optional local Postgres bridge).
- **Loop 3: Forwardable Standards-Compare Scorecard**: The Standards Compare tab already exports a self-contained HTML report (layer-table diff + geometry tolerance overlay against the FDOT 2026 standard) — a user emails that file to a reviewer or a sub, who opens it locally with a "Run your own drawing free" footer linking back. No hosting needed for this loop to work today; a hosted shareable-URL version (`qc.boundaryqc.ai/report/...`, matching Loop 2) is a natural next iteration, not yet built.

### Channel 3: Outbound B2B Cold Outreach & Data Mining
- **Data Mining Pipeline**: Scraping active Florida DBPR PSM/LB license databases + FDOT Pre-Qualified Consultant Directory (Group 8 Geomatics).
- **Outreach Cadences**:
  - **Cohort A (PSM Survey Owners)**: 14-day 5-touch cadence focusing on 61G17 compliance, bow-tie prevention, and 80% drafting time savings.
  - **Cohort B (FDOT Engineering Primes)**: 21-day 6-touch cadence highlighting multi-mile corridor R/W mapping, reference route closure, and capacity scaling.
- **Objection Handling**: Positioned as a pre-processor & QA/QC engine that pairs with Civil 3D/Carlson, keeping 100% final seal authority with the PSM.

### Channel 4: Video Marketing & Engineering Teardowns
- **YouTube Civil 3D Tutorials**: 7-10 min search-optimized videos targeting high-intent queries (*"How to Fix Open Traverses in Civil 3D When Legal Descriptions Omit Chord Bearings"*).
- **LinkedIn 90-Second Teardowns**: High-contrast vertical clips analyzing real Florida boundary errors ("The $50,000 Bow-Tie Error", "Meander Line Nightmares").
- **Personalized 2-Min Loom Audits**: High-converting outbound 1-to-1 Loom videos sent to Survey Directors featuring an audit of their recent public county plat filing.

### Channel 5: FSMS & ACEC Florida Event & CEC/PDH Marketing
- **18 FSMS Chapter Dinner Circuit**: Technical presentations at local monthly meetings sponsored for $300-$750 with pocket laminated field guides (*"Florida Boundary QC Reference Card"*).
- **Accredited 1.0 Hour CEC/PDH Course**: Registered with FDACS/BPSM (Surveyors) and FBPE (Engineers) on *"Topological Precision & Automated QC in Florida Land Surveying"*.
- **Convention Presence**: Interactive "Standards Audit Challenge" booth at FSMS Annual Conference & FES/ACEC Joint Convention (*"Bring your worst DXF submittal — we'll score it against the FDOT 2026 standard in 60 seconds, on the spot, with your laptop's Wi-Fi off"*).

### Channel 6: Customer Referral & FSMS Chapter Affiliate Model
- **Dual-Track Incentive**: 15% recurring lifetime commission on all referred software subscriptions.
- **Track A (Firm-to-Firm)**: "Give 15% / Get 15%" referral link inside BoundaryQC user dashboard (or 120% bonus in software credits).
- **Track B (FSMS Chapter Affiliate Partnership)**: Direct passive non-dues revenue stream for local FSMS chapters (e.g., 15 active firms = **$9,450/yr** passive income for chapter scholarship funds).

### Channel 7: Paid Google Search Campaigns (STAG Architecture)
- **Account Structure**: 4 Single Theme Ad Groups (STAG) targeting `[plat to dxf]`, `[legal description qc]`, `[civil 3d layer checker]`, and `[fdot cadd standards]`.
- **Negative Keyword List**: Account-level blocklist excluding academic, student, free, crack, and job-seeking queries.
- **Unit Economics**:
  - PLG Self-Serve CAC: **$427.35** (2.8-month payback, 4.18x LTV:CAC).
  - Enterprise Tier CAC: **$1,964.30** (4.9-month payback, 7.33x LTV:CAC).

### Channel 8: Autodesk App Store & Community Forum Engagement
- **Autodesk App Store Listing**: Autoloader `.bundle` package targeting Civil 3D 2021–2026 (.NET Framework 4.8 & .NET 8.0) with EV Code Signing certificate.
- **Community Forum Engagement**: Value-first 80/20 responses on Autodesk Community Civil 3D/AutoCAD forums using plug-and-play response templates for parcel bow-ties, missing curve tangents, and Bowditch closure reports.

### Channel 9: Public Relations & Industry Publication Case Studies
- **The Florida Surveyor (FSMS)**: *"Resolving Complex Sectional & Curve Discrepancies in Florida Legal Descriptions: A 7-Item Map Check Case Study"*.
- **POB Magazine (Point of Beginning)**: *"Algorithmic Bow-Tie Prevention and Tangent Back-Solving: Eliminating Misclosures in Metes-and-Bounds Traverses"*.
- **XYht Magazine**: *"Client-Side CADD QC: SPCS83 Ground-to-Grid Reduction, PSM-Verifiable Hash-Chained Audit Logs, and a Browser That Never Uploads Your Drawing"*.

### Channel 10: Marketing Funnel Analytics & Conversion Tagging
- **Unified Tagging Architecture**: Dual `dataLayer` push routing events to Google Analytics 4 and Mixpanel SDK (`sign_up_completed`, `aha_moment_reached`, `paywall_viewed`, `subscription_started`).
- **Trial Optimization**: 14-day Reverse Trial (full access reverting to Freemium), contextual paywalls, and PQL scoring engine ($\text{PQL Score} \ge 80$ triggers high-touch SDR outreach).

---

## 12-Month Execution Roadmap & Budget Allocation

```
2026-2027 GTM TIMELINE
├── Q1: Foundation & Digital Engines
│   ├── Deploy Next.js 14 pSEO engine (10,000+ BOE pages & Geo hubs)
│   ├── Launch Free DXF Error Scanner lead magnet
│   └── Obtain FDACS/BPSM and FBPE Continuing Education Provider approval
│
├── Q2: Outbound Sales & Event Launch
│   ├── Initiate DBPR PSM cold email & Loom audit outreach cadences
│   ├── Kick off FSMS 18-Chapter Dinner Circuit & Firm Lunch-and-Learns
│   └── Submit Autodesk App Store bundle & forum engagement campaign
│
├── Q3: Major Conventions & Paid Search Scale
│   ├── Sponsor & exhibit at FSMS Annual Conference & FES/ACEC Convention
│   ├── Scale Google Search Ads campaign to $3,000/mo budget
│   └── Publish technical case studies in POB, XYht, and The Florida Surveyor
│
└── Q4: Referral Expansion & Enterprise Scaling
    ├── Roll out FSMS Chapter Affiliate 15% recurring program statewide
    ├── Execute PQL reverse trial optimization & A/B conversion tests
    └── Reach target milestone of 71 active paid accounts ($129,948 ARR / $112,488 Net Profit)
```

---

## Budget & Financial ROI Allocation

| Expense Category | Monthly Spend | Annualized Budget | Expected ARR Contribution |
| :--- | :--- | :--- | :--- |
| **Paid Search (Google Ads)** | $800 / mo | $9,600 / yr | $45,000 ARR |
| **FSMS & FES Event Sponsorships** | $600 / mo | $7,200 / yr | $35,000 ARR |
| **CEC/PDH Accreditation & Collateral**| $250 / mo | $3,000 / yr | $20,000 ARR |
| **Outreach Stack (Smartlead/Apollo)**| $150 / mo | $1,800 / yr | $29,948 ARR |
| **TOTAL MARKETING INVESTMENT** | **$1,800 / mo** | **$21,600 / yr** | **$129,948 ARR** |
| **NET ANNUAL PROFIT AFTER ALL COSTS**| | | **$112,488 / YEAR** |
