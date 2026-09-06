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
  /** 0124 — the deliverables list, read off the proposal. */
  whatsIncluded: string;
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
  /**
   * 0124 — what to send NOW, under the 70/30 terms. "Balance due" is a fact;
   * these are the instruction, and a client reading the page on day one needs
   * the instruction.
   */
  payNow: string;
  payNowUpfrontNote: (percent: number) => string;
  payNowFinalNote: string;
  payLater: string;
  payLaterNote: (percent: number) => string;
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
  /** 0112 — progress, the latest update, the site itself */
  overallProgress: string;
  youAreHere: string;
  notStartedYet: string;
  latestUpdate: string;
  noUpdateYet: string;
  daysToGo: (n: number) => string;
  dueToday: string;
  pastTarget: string;
  previewSite: string;
  visitLiveSite: string;
  launchedOn: string;
  /** 0117 — the referral block */
  referTitle: string;
  referBlurb: string;
  referCopy: string;
  referCopied: string;
  /** 0120 — the bank-slip card */
  slipTitle: string;
  slipBlurb: string;
  slipButton: string;
  slipPending: string;
  slipThanks: string;
  slipNote: string;
  stages: Record<DeliveryStage, string>;
};

const EN: Copy = {
  workspace: "Your project workspace",
  whatWereBuilding: "What we're building",
  whatsIncluded: "What's included",
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
  payNow: "Due today",
  payNowUpfrontNote: (percent) =>
    `${percent}% of the project value, to get started. Work begins once this is received.`,
  payNowFinalNote:
    "The balance, now the work is complete — due before launch, handover and transfer of the final files.",
  payLater: "Due on completion",
  payLaterNote: (percent) =>
    `The remaining ${percent}%, payable once the work is finished and before handover.`,
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
  // 0112
  overallProgress: "Overall progress",
  youAreHere: "You are here:",
  notStartedYet: "Not started yet",
  latestUpdate: "Latest update",
  noUpdateYet: "We'll post updates here as the work moves along.",
  daysToGo: (n) => (n === 1 ? "1 day to go" : `${n} days to go`),
  dueToday: "Due today",
  pastTarget: "Past the target date — we'll confirm a new one with you",
  previewSite: "Preview your site",
  visitLiveSite: "Visit your live site",
  launchedOn: "Launched on",
  referTitle: "Know someone who needs this?",
  referBlurb:
    "Share your link — when they become a client, we'll thank you properly.",
  referCopy: "Copy your link",
  referCopied: "Copied",
  slipTitle: "Paid by bank transfer?",
  slipBlurb:
    "Send us the slip or a screenshot of the transfer and we'll update your balance once it lands.",
  slipButton: "Send the slip",
  slipPending: "We have your slip — we'll confirm it shortly and let you know.",
  slipThanks: "Thank you — we've got it. We'll confirm the payment shortly and let you know.",
  slipNote: "Anything we should know? (optional)",
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
  whatsIncluded: "ඇතුළත් වන දේ",
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
  payNow: "අද ගෙවිය යුතුයි",
  payNowUpfrontNote: (percent) =>
    `ව්‍යාපෘති වටිනාකමින් ${percent}%, වැඩ ආරම්භ කිරීමට. මෙය ලැබුණු පසු වැඩ ආරම්භ වේ.`,
  payNowFinalNote:
    "වැඩ අවසන් බැවින් ඉතිරි මුදල — දියත් කිරීම, භාර දීම සහ අවසාන ගොනු පැවරීමට පෙර ගෙවිය යුතුයි.",
  payLater: "වැඩ අවසන් වූ පසු ගෙවිය යුතුයි",
  payLaterNote: (percent) =>
    `ඉතිරි ${percent}%, වැඩ අවසන් වූ පසු සහ භාර දීමට පෙර ගෙවිය යුතුයි.`,
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
  // 0112
  overallProgress: "සමස්ත ප්‍රගතිය",
  youAreHere: "ඔබ දැන් සිටින්නේ:",
  notStartedYet: "තවම ආරම්භ වී නැත",
  latestUpdate: "නවතම යාවත්කාලීනය",
  noUpdateYet: "වැඩ ඉදිරියට යන විට යාවත්කාලීන මෙහි පළ කරන්නෙමු.",
  daysToGo: (n) => `තව දින ${n}යි`,
  dueToday: "නියමිත දිනය අදයි",
  pastTarget: "නියමිත දිනය පසු වී ඇත — නව දිනයක් ඔබ සමඟ තහවුරු කරන්නෙමු",
  previewSite: "ඔබේ වෙබ් අඩවියේ පෙරදසුන බලන්න",
  visitLiveSite: "ඔබේ සජීවී වෙබ් අඩවියට යන්න",
  launchedOn: "දියත් කළ දිනය",
  referTitle: "මෙවැනි සේවාවක් අවශ්‍ය කෙනෙකු දන්නවාද?",
  referBlurb:
    "ඔබේ සබැඳිය බෙදාගන්න — ඔවුන් අපගේ සේවාදායකයෙකු වූ විට අපි ඔබට නිසි ලෙස ස්තූති කරන්නෙමු.",
  referCopy: "ඔබේ සබැඳිය පිටපත් කරන්න",
  referCopied: "පිටපත් කළා",
  slipTitle: "බැංකු මාරුවකින් ගෙවුවාද?",
  slipBlurb:
    "ගෙවීම් රිසිට්පත හෝ මාරුවේ තිර රුවක් අපට එවන්න — මුදල් ලැබුණු විගස ඔබේ ශේෂය යාවත්කාලීන කරන්නෙමු.",
  slipButton: "රිසිට්පත එවන්න",
  slipPending: "ඔබේ රිසිට්පත අප සතුයි — ඉක්මනින් තහවුරු කර ඔබට දන්වන්නෙමු.",
  slipThanks: "ස්තූතියි — ලැබුණා. ගෙවීම ඉක්මනින් තහවුරු කර ඔබට දන්වන්නෙමු.",
  slipNote: "අප දැනගත යුතු දෙයක් තිබේද? (විකල්ප)",
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
  whatsIncluded: "உள்ளடங்குவது",
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
  payNow: "இன்று செலுத்த வேண்டியது",
  payNowUpfrontNote: (percent) =>
    `திட்ட மதிப்பில் ${percent}%, வேலையைத் தொடங்க. இது கிடைத்ததும் வேலை தொடங்கும்.`,
  payNowFinalNote:
    "வேலை முடிந்துவிட்டதால் மீதித் தொகை — வெளியீடு, ஒப்படைப்பு மற்றும் இறுதிக் கோப்புகள் மாற்றத்திற்கு முன் செலுத்த வேண்டும்.",
  payLater: "வேலை முடிந்ததும் செலுத்த வேண்டியது",
  payLaterNote: (percent) =>
    `மீதமுள்ள ${percent}%, வேலை முடிந்ததும் ஒப்படைப்புக்கு முன் செலுத்த வேண்டும்.`,
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
  // 0112
  overallProgress: "ஒட்டுமொத்த முன்னேற்றம்",
  youAreHere: "நீங்கள் இப்போது இங்கே:",
  notStartedYet: "இன்னும் தொடங்கவில்லை",
  latestUpdate: "சமீபத்திய புதுப்பிப்பு",
  noUpdateYet: "வேலை முன்னேறும்போது புதுப்பிப்புகளை இங்கே பதிவிடுவோம்.",
  daysToGo: (n) => `இன்னும் ${n} நாட்கள்`,
  dueToday: "இன்றே இலக்கு நாள்",
  pastTarget: "இலக்கு நாள் கடந்துவிட்டது — புதிய நாளை உங்களுடன் உறுதிப்படுத்துவோம்",
  previewSite: "உங்கள் தளத்தை முன்னோட்டமாகப் பாருங்கள்",
  visitLiveSite: "உங்கள் நேரலை தளத்திற்குச் செல்லுங்கள்",
  launchedOn: "தொடங்கப்பட்ட நாள்",
  referTitle: "இது தேவைப்படும் யாரையாவது தெரியுமா?",
  referBlurb:
    "உங்கள் இணைப்பைப் பகிருங்கள் — அவர்கள் எங்கள் வாடிக்கையாளராகும் போது, உங்களுக்கு முறையாக நன்றி சொல்வோம்.",
  referCopy: "உங்கள் இணைப்பை நகலெடுக்கவும்",
  referCopied: "நகலெடுக்கப்பட்டது",
  slipTitle: "வங்கிப் பரிமாற்றம் மூலம் செலுத்தினீர்களா?",
  slipBlurb:
    "ரசீதையோ பரிமாற்றத்தின் திரைப்படத்தையோ எங்களுக்கு அனுப்புங்கள் — பணம் வந்ததும் உங்கள் நிலுவையைப் புதுப்பிப்போம்.",
  slipButton: "ரசீதை அனுப்பவும்",
  slipPending: "உங்கள் ரசீது எங்களிடம் உள்ளது — விரைவில் உறுதிப்படுத்தி உங்களுக்குத் தெரிவிப்போம்.",
  slipThanks: "நன்றி — கிடைத்தது. விரைவில் பணத்தை உறுதிப்படுத்தி உங்களுக்குத் தெரிவிப்போம்.",
  slipNote: "நாங்கள் அறிய வேண்டியது ஏதேனும் உள்ளதா? (விருப்பத்திற்குரியது)",
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

/**
 * The same message for a WhatsApp button send (0112): the link rides the
 * "Open your project" button, so the body never repeats it as a raw URL.
 */
export function portalCtaBody(opts: {
  name: string;
  projectName: string;
  passcode: string | null;
  note?: string;
}): string {
  return [
    `Hi ${opts.name}, you can follow ${opts.projectName} and send us anything we need — tap the button below.`,
    opts.passcode ? `Passcode: ${opts.passcode}` : null,
    opts.note?.trim() || null,
    "— ARC AI",
  ]
    .filter(Boolean)
    .join("\n");
}
