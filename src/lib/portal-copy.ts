import type { DeliveryStage, PortalLanguage } from "@/lib/types";

/**
 * The client portal's words, in the three languages ARC AI's clients use
 * (0094).
 *
 * The WhatsApp agent has detected and switched language per contact since
 * 0055; the portal has been English-only, which is a strange thing to hand a
 * Colombo shop owner alongside a Sinhala conversation.
 *
 * Only the client-facing surfaces are translated — the team never sees these
 * strings. Numbers, dates and currency stay in the app's existing formats:
 * "Rs. 84,000" reads the same in all three, and inventing local number
 * formatting here would make the portal disagree with the invoice.
 *
 * NOTE: these translations were written by the system, not a native speaker.
 * They're accurate enough to be far better than English-only, but worth a
 * read-through by someone fluent before they go in front of a client.
 */

type Copy = {
  workspace: string;
  whatWereBuilding: string;
  targetCompletion: string;
  whereYouAre: string;
  waitingOnYouOne: string;
  waitingOnYouMany: (n: number) => string;
  uploadBelow: string;
  yourAccount: string;
  totalValue: string;
  paidSoFar: string;
  balanceDue: string;
  settledPercent: (n: number) => string;
  paymentsReceived: string;
  deposit: string;
  paymentReceived: string;
  whatWeNeed: string;
  nothingToSend: string;
  weWillAddHere: string;
  upload: string;
  uploading: string;
  optional: string;
  uploadedOn: string;
  privateNote: string;
  /** Passcode gate */
  lockedTitle: string;
  lockedBlurb: string;
  passcodeLabel: string;
  openButton: string;
  wrongCode: string;
  lockedOut: string;
  expired: string;
  revoked: string;
  /** Interactive sections */
  askTitle: string;
  askBlurb: string;
  askPlaceholder: string;
  askSend: string;
  askSent: string;
  approveTitle: string;
  approveBlurb: string;
  approveName: string;
  approveButton: string;
  approveChanges: string;
  approvedOn: string;
  pulseTitle: string;
  pulseBad: string;
  pulseOk: string;
  pulseGreat: string;
  pulseThanks: string;
  stages: Record<DeliveryStage, string>;
};

const EN: Copy = {
  workspace: "Your project workspace",
  whatWereBuilding: "What we're building",
  targetCompletion: "Target completion",
  whereYouAre: "Where your project is",
  waitingOnYouOne: "We're waiting on 1 item from you",
  waitingOnYouMany: (n) => `We're waiting on ${n} items from you`,
  uploadBelow: "Upload below and we'll keep moving.",
  yourAccount: "Your account",
  totalValue: "Total project value",
  paidSoFar: "Paid so far",
  balanceDue: "Balance due",
  settledPercent: (n) => `${n}% settled`,
  paymentsReceived: "Payments received",
  deposit: "Deposit",
  paymentReceived: "Payment received",
  whatWeNeed: "What we need from you",
  nothingToSend: "Nothing to send right now",
  weWillAddHere: "We'll add anything we need here — you'll see it on this page.",
  upload: "Upload",
  uploading: "Uploading…",
  optional: "optional",
  uploadedOn: "Uploaded",
  privateNote: "This page is private to you. Please don't share the link.",
  lockedTitle: "Enter your passcode",
  lockedBlurb: "We texted it to you along with this link.",
  passcodeLabel: "Passcode",
  openButton: "Open my project",
  wrongCode: "That code didn't work.",
  lockedOut: "Too many attempts — please try again shortly.",
  expired: "This link has expired. Ask us for a new one.",
  revoked: "This link is no longer active. Ask us for a new one.",
  askTitle: "Need something changed?",
  askBlurb:
    "Tell us here and we'll come back to you with what it involves and what it costs.",
  askPlaceholder: "Could we also add a booking form to the contact page?",
  askSend: "Send request",
  askSent: "Sent — we'll come back to you shortly.",
  approveTitle: "Ready for your approval",
  approveBlurb: "Have a look, then sign off with your name.",
  approveName: "Your name",
  approveButton: "Approve",
  approveChanges: "Request changes",
  approvedOn: "Approved",
  pulseTitle: "How's it going so far?",
  pulseBad: "Not great",
  pulseOk: "Fine",
  pulseGreat: "Great",
  pulseThanks: "Thank you — that helps.",
  stages: {
    onboarding: "Getting started",
    assets: "Collecting your content",
    build: "Building your project",
    review: "Ready for your review",
    delivered: "Delivered",
    aftercare: "Aftercare",
  },
};

const SI: Copy = {
  workspace: "ඔබේ ව්‍යාපෘති අවකාශය",
  whatWereBuilding: "අපි ගොඩනඟන දේ",
  targetCompletion: "අවසන් කිරීමට නියමිත දිනය",
  whereYouAre: "ඔබේ ව්‍යාපෘතිය දැන් කොහෙද",
  waitingOnYouOne: "අපි ඔබෙන් එක් දෙයක් බලාපොරොත්තුවෙන් සිටිමු",
  waitingOnYouMany: (n) => `අපි ඔබෙන් දේවල් ${n}ක් බලාපොරොත්තුවෙන් සිටිමු`,
  uploadBelow: "පහතින් උඩුගත කරන්න, අපි ඉදිරියට යමු.",
  yourAccount: "ඔබේ ගිණුම",
  totalValue: "මුළු ව්‍යාපෘති වටිනාකම",
  paidSoFar: "මේ දක්වා ගෙවා ඇත",
  balanceDue: "ගෙවීමට ඉතිරි",
  settledPercent: (n) => `${n}% ගෙවා ඇත`,
  paymentsReceived: "ලැබුණු ගෙවීම්",
  deposit: "තැන්පතුව",
  paymentReceived: "ගෙවීම ලැබුණි",
  whatWeNeed: "ඔබෙන් අපට අවශ්‍ය දේ",
  nothingToSend: "දැනට එවීමට කිසිවක් නැත",
  weWillAddHere: "අවශ්‍ය දේ අපි මෙහි එකතු කරමු — ඔබට මෙම පිටුවේ පෙනෙනු ඇත.",
  upload: "උඩුගත කරන්න",
  uploading: "උඩුගත වෙමින්…",
  optional: "අත්‍යවශ්‍ය නොවේ",
  uploadedOn: "උඩුගත කළේ",
  privateNote: "මෙම පිටුව ඔබට පමණි. කරුණාකර සබැඳිය බෙදා නොගන්න.",
  lockedTitle: "ඔබේ මුරකේතය ඇතුළත් කරන්න",
  lockedBlurb: "අපි එය මෙම සබැඳිය සමඟ කෙටි පණිවිඩයෙන් එවා ඇත.",
  passcodeLabel: "මුරකේතය",
  openButton: "මගේ ව්‍යාපෘතිය විවෘත කරන්න",
  wrongCode: "එම කේතය වැරදියි.",
  lockedOut: "උත්සාහ කිහිපයක් වැරදුණි — කරුණාකර ටික වේලාවකින් නැවත උත්සාහ කරන්න.",
  expired: "මෙම සබැඳියේ කාලය අවසන්. අලුත් එකක් අපෙන් ඉල්ලන්න.",
  revoked: "මෙම සබැඳිය තවදුරටත් ක්‍රියාත්මක නොවේ. අලුත් එකක් අපෙන් ඉල්ලන්න.",
  askTitle: "යමක් වෙනස් කළ යුතුද?",
  askBlurb: "මෙහි කියන්න — එයට අවශ්‍ය දේ සහ මිල අපි ඔබට දන්වන්නෙමු.",
  askPlaceholder: "සම්බන්ධතා පිටුවට වෙන්කරවා ගැනීමේ පෝරමයක් එකතු කළ හැකිද?",
  askSend: "ඉල්ලීම යවන්න",
  askSent: "යවා ඇත — අපි ඉක්මනින් ඔබට දන්වන්නෙමු.",
  approveTitle: "ඔබේ අනුමැතියට සූදානම්",
  approveBlurb: "බලා, ඔබේ නම සමඟ අනුමත කරන්න.",
  approveName: "ඔබේ නම",
  approveButton: "අනුමත කරන්න",
  approveChanges: "වෙනස්කම් ඉල්ලන්න",
  approvedOn: "අනුමත කළේ",
  pulseTitle: "මේ දක්වා කොහොමද?",
  pulseBad: "එතරම් හොඳ නැහැ",
  pulseOk: "හොඳයි",
  pulseGreat: "ඉතා හොඳයි",
  pulseThanks: "ස්තූතියි — එය අපට උදවු වේ.",
  stages: {
    onboarding: "පටන් ගනිමු",
    assets: "ඔබේ අන්තර්ගතය එකතු කිරීම",
    build: "ඔබේ ව්‍යාපෘතිය තැනීම",
    review: "ඔබේ සමාලෝචනයට සූදානම්",
    delivered: "භාර දෙන ලදී",
    aftercare: "පසු සේවා",
  },
};

const TA: Copy = {
  workspace: "உங்கள் திட்டப் பணியிடம்",
  whatWereBuilding: "நாங்கள் உருவாக்குவது",
  targetCompletion: "நிறைவு செய்ய இலக்கு நாள்",
  whereYouAre: "உங்கள் திட்டம் இப்போது எங்கே",
  waitingOnYouOne: "உங்களிடமிருந்து ஒரு விஷயத்தை எதிர்பார்க்கிறோம்",
  waitingOnYouMany: (n) => `உங்களிடமிருந்து ${n} விஷயங்களை எதிர்பார்க்கிறோம்`,
  uploadBelow: "கீழே பதிவேற்றுங்கள், நாங்கள் தொடர்கிறோம்.",
  yourAccount: "உங்கள் கணக்கு",
  totalValue: "மொத்தத் திட்ட மதிப்பு",
  paidSoFar: "இதுவரை செலுத்தியது",
  balanceDue: "செலுத்த வேண்டியது",
  settledPercent: (n) => `${n}% செலுத்தப்பட்டது`,
  paymentsReceived: "பெறப்பட்ட கட்டணங்கள்",
  deposit: "முன்பணம்",
  paymentReceived: "கட்டணம் பெறப்பட்டது",
  whatWeNeed: "உங்களிடமிருந்து எங்களுக்குத் தேவையானவை",
  nothingToSend: "இப்போது அனுப்ப ஒன்றுமில்லை",
  weWillAddHere:
    "தேவைப்படுவதை நாங்கள் இங்கே சேர்ப்போம் — இந்தப் பக்கத்தில் உங்களுக்குத் தெரியும்.",
  upload: "பதிவேற்று",
  uploading: "பதிவேற்றுகிறது…",
  optional: "விருப்பத்தேர்வு",
  uploadedOn: "பதிவேற்றியது",
  privateNote: "இந்தப் பக்கம் உங்களுக்கு மட்டுமே. இணைப்பைப் பகிர வேண்டாம்.",
  lockedTitle: "உங்கள் கடவுக்குறியீட்டை உள்ளிடவும்",
  lockedBlurb: "இந்த இணைப்புடன் அதை உங்களுக்கு குறுஞ்செய்தியில் அனுப்பினோம்.",
  passcodeLabel: "கடவுக்குறியீடு",
  openButton: "என் திட்டத்தைத் திற",
  wrongCode: "அந்தக் குறியீடு சரியில்லை.",
  lockedOut: "பல முறை தவறாக முயன்றுள்ளீர்கள் — சிறிது நேரம் கழித்து முயலவும்.",
  expired: "இந்த இணைப்பு காலாவதியாகிவிட்டது. புதிய ஒன்றைக் கேளுங்கள்.",
  revoked: "இந்த இணைப்பு இனி செயல்படாது. புதிய ஒன்றைக் கேளுங்கள்.",
  askTitle: "ஏதாவது மாற்ற வேண்டுமா?",
  askBlurb:
    "இங்கே சொல்லுங்கள் — அதற்கு என்ன தேவை, என்ன செலவு என்று உங்களுக்குத் தெரிவிப்போம்.",
  askPlaceholder: "தொடர்புப் பக்கத்தில் முன்பதிவு படிவம் சேர்க்க முடியுமா?",
  askSend: "கோரிக்கையை அனுப்பு",
  askSent: "அனுப்பப்பட்டது — விரைவில் உங்களைத் தொடர்புகொள்வோம்.",
  approveTitle: "உங்கள் ஒப்புதலுக்குத் தயார்",
  approveBlurb: "பாருங்கள், பிறகு உங்கள் பெயருடன் ஒப்புதல் அளியுங்கள்.",
  approveName: "உங்கள் பெயர்",
  approveButton: "ஒப்புக",
  approveChanges: "மாற்றங்களைக் கோரு",
  approvedOn: "ஒப்புக்கொண்டது",
  pulseTitle: "இதுவரை எப்படி இருக்கிறது?",
  pulseBad: "சரியில்லை",
  pulseOk: "பரவாயில்லை",
  pulseGreat: "மிக நன்று",
  pulseThanks: "நன்றி — இது எங்களுக்கு உதவுகிறது.",
  stages: {
    onboarding: "தொடங்குகிறோம்",
    assets: "உங்கள் உள்ளடக்கம் சேகரிக்கிறோம்",
    build: "உங்கள் திட்டத்தை உருவாக்குகிறோம்",
    review: "உங்கள் பரிசீலனைக்குத் தயார்",
    delivered: "வழங்கப்பட்டது",
    aftercare: "பின் சேவை",
  },
};

const DICTIONARIES: Record<PortalLanguage, Copy> = { en: EN, si: SI, ta: TA };

/** The portal's words for a client. Falls back to English for anything odd. */
export function portalCopy(language: string | null | undefined): Copy {
  const key = (language ?? "en") as PortalLanguage;
  return DICTIONARIES[key] ?? EN;
}

export const PORTAL_LANGUAGES: { value: PortalLanguage; label: string }[] = [
  { value: "en", label: "English" },
  { value: "si", label: "සිංහල (Sinhala)" },
  { value: "ta", label: "தமிழ் (Tamil)" },
];

export type PortalCopy = Copy;

/**
 * The text that carries the portal to a client.
 *
 * Lives here rather than beside the action that sends it because a
 * "use server" module may only export async functions — and the team needs to
 * see this message rendered in the browser, exactly as it will arrive, before
 * pressing send.
 */
export function portalMessage(opts: {
  name: string;
  projectName: string;
  link: string;
  passcode: string | null;
  note?: string;
}): string {
  return [
    `Hi ${opts.name}, you can follow ${opts.projectName} here and send us anything we need:`,
    opts.link,
    opts.passcode ? `Passcode: ${opts.passcode}` : null,
    opts.note?.trim() || null,
    "— ARC AI",
  ]
    .filter(Boolean)
    .join("\n");
}
