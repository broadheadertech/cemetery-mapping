/**
 * Brochure-side placeholder content. The same items will eventually
 * be replaced with Convex-backed reads (obituaries from the
 * interments collection, announcements from a CMS doc, etc.). For
 * now we keep them as static seed copy so the marketing site can
 * ship without a CMS dependency.
 *
 * Tone notes (brand voice pillars: Reverent, Compassionate, Permanent,
 * Restrained): names are plausible-fiction, never real-sounding enough
 * to be confused with a real local family. Dates are recent so the
 * "recently laid to rest" framing reads honestly when previewed.
 */

export type LotType = {
  id: "single" | "family" | "mausoleum" | "niche";
  tag: string;
  name: string;
  priceFrom: string;
  summary: string;
  inclusions: ReadonlyArray<string>;
};

export const LOT_TYPES: ReadonlyArray<LotType> = [
  {
    id: "single",
    tag: "Single plot",
    name: "Single lot",
    priceFrom: "₱85,000",
    summary: "For one. 1 m × 2.4 m. Available in any garden.",
    inclusions: [
      "Perpetual care included",
      "Standard marker base",
      "24-month installment available",
      "Right of visitation in perpetuity",
    ],
  },
  {
    id: "family",
    tag: "Family estate",
    name: "Family lot",
    priceFrom: "₱340,000",
    summary: "For four to six. 4 m × 2.4 m. Garden of Faith & Peace.",
    inclusions: [
      "Perpetual care included",
      "Estate marker option",
      "48-month installment available",
      "Transferable to direct heirs",
      "Garden landscaping access",
    ],
  },
  {
    id: "mausoleum",
    tag: "Above ground",
    name: "Mausoleum",
    priceFrom: "₱1,200,000",
    summary: "Six to twelve crypts. Mausoleum Row.",
    inclusions: [
      "Built-to-spec construction",
      "Perpetual care included",
      "60-month financing available",
      "Architectural consultation",
      "Private interior space",
    ],
  },
  {
    id: "niche",
    tag: "Cremation",
    name: "Columbarium niche",
    priceFrom: "₱42,000",
    summary: "Single or double urn. Columbarium East.",
    inclusions: [
      "Perpetual care included",
      "Bronze nameplate",
      "12-month installment available",
      "Indoor & outdoor niches",
      "Family wall option",
    ],
  },
];

export type Obituary = {
  name: string;
  born: string;
  died: string;
  section: string;
  service: string;
  date: string;
};

export const OBITUARIES: ReadonlyArray<Obituary> = [
  {
    name: "Maria Soledad Reyes",
    born: "1947",
    died: "2024",
    section: "Garden of Faith · B-104",
    service: "Catholic mass",
    date: "15 Nov 2024",
  },
  {
    name: "Ernesto Villamor Cruz",
    born: "1939",
    died: "2024",
    section: "Mausoleum Row · M-12",
    service: "Family service",
    date: "12 Nov 2024",
  },
  {
    name: "Lucia Mendoza-Tan",
    born: "1952",
    died: "2024",
    section: "Garden of Grace · A-208",
    service: "Catholic mass",
    date: "08 Nov 2024",
  },
  {
    name: "Roberto Salvador Lim",
    born: "1944",
    died: "2024",
    section: "Garden of Peace · E-061",
    service: "Iglesia ni Cristo",
    date: "03 Nov 2024",
  },
  {
    name: "Adelina Pascual de la Cruz",
    born: "1936",
    died: "2024",
    section: "Columbarium East · CE-340",
    service: "Private",
    date: "29 Oct 2024",
  },
  {
    name: "Jose Antonio Magbanua",
    born: "1958",
    died: "2024",
    section: "Garden of Hope · C-145",
    service: "Catholic mass",
    date: "24 Oct 2024",
  },
];

export type Announcement = {
  date: string;
  title: string;
  body: string;
};

export const ANNOUNCEMENTS: ReadonlyArray<Announcement> = [
  {
    date: "12 Nov 2024",
    title: "All Saints’ Day 2024 — thank you",
    body: "Over 11,000 visitors over the two-day observance. The candles burned until dawn. We are grateful for the families who came home.",
  },
  {
    date: "28 Oct 2024",
    title: "Garden of Hope — phase II now open",
    body: "180 new family plots in our newest garden. Walking tours every Saturday at 9am throughout November.",
  },
  {
    date: "15 Oct 2024",
    title: "Annual remembrance service",
    body: "Saturday 16 November at 4pm in the chapel. Open to all families. Light refreshments after.",
  },
];

export type ResourceArticle = {
  eyebrow: string;
  title: string;
  meta: string;
};

export const RESOURCE_ARTICLES: ReadonlyArray<ResourceArticle> = [
  {
    eyebrow: "When the call comes",
    title: "The first 24 hours: a practical guide",
    meta: "8 min read",
  },
  {
    eyebrow: "Arrangements",
    title: "Choosing between burial and cremation",
    meta: "6 min read",
  },
  {
    eyebrow: "Paperwork",
    title: "Death certificates and what you will need them for",
    meta: "5 min read",
  },
  {
    eyebrow: "Children",
    title: "Helping a child understand a loss",
    meta: "12 min read",
  },
  {
    eyebrow: "Tradition",
    title: "Filipino mourning customs: a brief overview",
    meta: "10 min read",
  },
  {
    eyebrow: "After",
    title: "The first All Saints’ Day: what to expect",
    meta: "7 min read",
  },
];

export type Faq = {
  q: string;
  a: string;
};

export const FAQS: ReadonlyArray<Faq> = [
  {
    q: "Do we need to be parishioners to be buried here?",
    a: "No. We welcome families of every faith and of none. We have Catholic, Iglesia, Born-Again, Buddhist, and non-religious interments on the grounds. The chapel is non-denominational.",
  },
  {
    q: "Is there an annual fee for perpetual care?",
    a: "No. Perpetual care is included in the lot price — once, in full, never to be invoiced again. This is written into every contract.",
  },
  {
    q: "Can a lot be transferred to my children?",
    a: "Yes. Lots are transferable to direct heirs without fee. We will help with the documentation when the time comes.",
  },
  {
    q: "Can I be buried near a family member already here?",
    a: "Often yes, depending on the section. Bring the existing lot number to your visit and we will check availability of the surrounding plots.",
  },
  {
    q: "What happens if I default on installments?",
    a: "We do not foreclose. If you miss two consecutive months we call you. After six months of non-payment, the lot is returned to inventory and 80% of paid principal is refunded.",
  },
  {
    q: "Do you offer cremation?",
    a: "We do not perform cremations on-site, but we work with two trusted crematoria in San Fernando and Bauang. Niche placement and ceremony happen with us.",
  },
];
