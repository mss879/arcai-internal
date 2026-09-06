/**
 * The business types Find Leads can sweep for.
 *
 * Each string is used verbatim as a Google Places text query —
 * `"<type> in <city>, <country>"` (see `runSearch` in `lib/prospecting.ts`) —
 * so they must read like something a person would type into Maps, not like an
 * internal enum. That also means the list is open-ended: the launcher lets the
 * user add their own type, and anything sensible works.
 *
 * The groups exist only so ~120 chips stay findable in the picker.
 */
export type ProspectCategoryGroup = {
  label: string;
  items: string[];
};

export const PROSPECT_CATEGORY_GROUPS: ProspectCategoryGroup[] = [
  {
    label: "Food & drink",
    items: [
      "Restaurants",
      "Cafes & bakeries",
      "Fast food & takeaway",
      "Bars & pubs",
      "Ice cream & dessert shops",
      "Catering services",
      "Food delivery kitchens",
    ],
  },
  {
    label: "Hotels & travel",
    items: [
      "Hotels & guest houses",
      "Villas & homestays",
      "Resorts",
      "Travel agencies",
      "Tour operators",
      "Car rentals",
      "Taxi & transport services",
    ],
  },
  {
    label: "Beauty & wellness",
    items: [
      "Salons & spas",
      "Barber shops",
      "Nail salons",
      "Massage & wellness centres",
      "Tattoo studios",
      "Yoga & meditation studios",
      "Cosmetic & skin clinics",
    ],
  },
  {
    label: "Health & medical",
    items: [
      "Dental clinics",
      "Medical clinics",
      "Pharmacies",
      "Optical & eyewear stores",
      "Physiotherapy centres",
      "Ayurvedic centres",
      "Diagnostic labs",
      "Hearing & mobility care",
      "Nursing & elder care",
    ],
  },
  {
    label: "Fitness & sports",
    items: [
      "Gyms & fitness centers",
      "Sports clubs & academies",
      "Martial arts & boxing gyms",
      "Swimming schools & pools",
      "Sports equipment stores",
    ],
  },
  {
    label: "Vehicles & automotive",
    items: [
      "Vehicle dealerships",
      "Used car dealers",
      "Motorcycle & scooter dealers",
      "Car repair & service",
      "Auto parts & accessories",
      "Tyre & battery shops",
      "Car wash & detailing",
      "Vehicle rentals & leasing",
      "Vehicle import & clearing agents",
      "Driving schools",
      "Bicycle shops",
    ],
  },
  {
    label: "Shops & retail",
    items: [
      "Clothing stores",
      "Watch stores",
      "Jewellery stores",
      "Shoe stores",
      "Bags & leather goods",
      "Bridal & tailoring shops",
      "Mobile phone shops",
      "Computer & electronics stores",
      "Home appliance stores",
      "Furniture stores",
      "Home decor & lighting",
      "Kitchen & bathroom showrooms",
      "Hardware stores",
      "Paint & tile stores",
      "Book & stationery shops",
      "Toy & baby stores",
      "Gift & souvenir shops",
      "Florists",
      "Musical instrument shops",
      "Art & craft shops",
      "Supermarkets & grocers",
      "Organic & health food stores",
      "Liquor & wine shops",
    ],
  },
  {
    label: "Home & trades",
    items: [
      "Construction companies",
      "Interior designers",
      "Architects",
      "Electricians",
      "Plumbers",
      "Air conditioning services",
      "Painters & decorators",
      "Roofing & waterproofing",
      "Carpenters & joinery",
      "Aluminium & glass fabricators",
      "Curtains & blinds suppliers",
      "Landscaping & gardening",
      "Cleaning services",
      "Pest control",
      "Movers & packers",
      "Security & CCTV installers",
      "Solar power installers",
      "Generator & power equipment",
    ],
  },
  {
    label: "Professional services",
    items: [
      "Law firms",
      "Accountants & auditors",
      "Insurance agents",
      "Financial advisors",
      "Real estate agencies",
      "Property management",
      "Marketing agencies",
      "IT services & support",
      "Recruitment agencies",
      "Business consultants",
      "Immigration & visa consultants",
      "Translation services",
      "Surveyors & valuers",
      "Co-working spaces",
    ],
  },
  {
    label: "Education & training",
    items: [
      "Tuition & training centers",
      "Language schools",
      "IT & vocational institutes",
      "Music schools",
      "Dance & performing arts schools",
      "Preschools & daycares",
      "Study abroad consultants",
    ],
  },
  {
    label: "Events & creative",
    items: [
      "Photographers",
      "Videographers",
      "Event planners",
      "Wedding services",
      "Banquet & function halls",
      "DJs & live entertainment",
      "Printing services",
      "Signage & branding",
      "Advertising & media production",
      "Party rentals & decor",
    ],
  },
  {
    label: "Leisure",
    items: [
      "Nightclubs & lounges",
      "Kids play centres",
      "Adventure & activity centres",
      "Water sports & diving",
      "Gaming & esports lounges",
    ],
  },
  {
    label: "Pets & animals",
    items: [
      "Pet care & vets",
      "Pet shops & grooming",
      "Aquarium & fish suppliers",
    ],
  },
  {
    label: "Trade & industry",
    items: [
      "Manufacturers & factories",
      "Wholesale & distributors",
      "Machinery & equipment suppliers",
      "Packaging suppliers",
      "Agriculture & farming supplies",
      "Warehousing & logistics",
      "Courier & delivery services",
      "Freight forwarders & shipping",
      "Garment & textile suppliers",
    ],
  },
];

/** Flat list of every built-in type — for datalists and lookups. */
export const PROSPECT_CATEGORIES: string[] = PROSPECT_CATEGORY_GROUPS.flatMap(
  (g) => g.items,
);

/**
 * Per-scan cap. Each type is its own Places search (billed, and capped at ~60
 * results), so the server slices the list — `startProspectScan` in
 * `crm/prospecting/actions.ts`. The picker enforces the same number so a
 * selection is never silently dropped.
 */
export const MAX_SCAN_CATEGORIES = 12;
