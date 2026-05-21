/**
 * US state → area codes mapping.
 * First entry per state is the primary/most-common area code used as the default.
 * Used to auto-suggest office_area_code when a company sets their state.
 */
const STATE_AREA_CODES = {
  AL: [205, 251, 256, 334, 938],
  AK: [907],
  AZ: [480, 520, 602, 623, 928],
  AR: [479, 501, 870],
  CA: [209, 213, 310, 323, 408, 415, 424, 442, 510, 530, 559, 562, 619, 626, 628, 650, 657, 661, 669, 707, 714, 747, 760, 805, 818, 831, 858, 909, 916, 925, 949, 951],
  CO: [303, 719, 720, 970],
  CT: [203, 475, 860, 959],
  DE: [302],
  FL: [239, 305, 321, 352, 386, 407, 561, 727, 754, 772, 786, 813, 850, 863, 904, 941, 954],
  GA: [229, 404, 470, 478, 678, 706, 762, 770, 912],
  HI: [808],
  ID: [208, 986],
  IL: [217, 224, 309, 312, 331, 447, 464, 618, 630, 708, 773, 779, 815, 847, 872],
  IN: [219, 260, 317, 463, 574, 765, 812, 930],
  IA: [319, 515, 563, 641, 712],
  KS: [316, 620, 785, 913],
  KY: [270, 364, 502, 606, 859],
  LA: [225, 318, 337, 504, 985],
  ME: [207],
  MD: [240, 301, 410, 443, 667],
  MA: [339, 351, 413, 508, 617, 774, 781, 857, 978],
  MI: [231, 248, 269, 313, 517, 586, 616, 734, 810, 906, 947, 989],
  MN: [218, 320, 507, 612, 651, 763, 952],
  MS: [228, 601, 662, 769],
  MO: [314, 417, 573, 636, 660, 816],
  MT: [406],
  NE: [308, 402, 531],
  NV: [702, 725, 775],
  NH: [603],
  NJ: [201, 551, 609, 640, 732, 848, 856, 862, 908, 973],
  NM: [505, 575],
  NY: [212, 315, 332, 347, 516, 518, 585, 607, 631, 646, 680, 716, 718, 838, 845, 914, 917, 929, 934],
  NC: [252, 336, 704, 743, 828, 910, 919, 980, 984],
  ND: [701],
  OH: [216, 220, 234, 330, 380, 419, 440, 513, 567, 614, 740, 937],
  OK: [405, 539, 580, 918],
  OR: [458, 503, 541, 971],
  PA: [215, 223, 267, 272, 412, 445, 484, 570, 610, 717, 724, 814, 878],
  RI: [401],
  SC: [803, 839, 843, 854, 864],
  SD: [605],
  TN: [423, 615, 629, 731, 865, 901, 931],
  TX: [210, 214, 254, 281, 325, 346, 361, 409, 430, 432, 469, 512, 682, 713, 726, 737, 806, 817, 830, 832, 903, 915, 936, 940, 945, 956, 972, 979],
  UT: [385, 435, 801],
  VT: [802],
  VA: [276, 434, 540, 571, 703, 757, 804],
  WA: [206, 253, 360, 425, 509, 564],
  WV: [304, 681],
  WI: [262, 414, 534, 608, 715, 920],
  WY: [307],
  // US territories
  DC: [202],
  PR: [787, 939],
  GU: [671],
  VI: [340],
  // Canada (supported by Retell)
  AB: [403, 587, 780, 825],
  BC: [236, 250, 604, 672, 778],
  MB: [204, 431],
  NB: [506],
  NL: [709],
  NS: [782, 902],
  ON: [226, 249, 289, 343, 365, 416, 437, 519, 548, 613, 647, 705, 807, 905],
  QC: [263, 354, 367, 418, 438, 450, 514, 579, 581, 819, 873],
  SK: [306, 639],
};

/**
 * Normalize state input — handles full names and abbreviations.
 */
const STATE_NAME_TO_CODE = {
  "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
  "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
  "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID",
  "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
  "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
  "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
  "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
  "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT",
  "vermont": "VT", "virginia": "VA", "washington": "WA", "west virginia": "WV",
  "wisconsin": "WI", "wyoming": "WY", "district of columbia": "DC",
};

function normalizeState(state) {
  if (!state) return null;
  const upper = state.trim().toUpperCase();
  if (STATE_AREA_CODES[upper]) return upper;
  const lower = state.trim().toLowerCase();
  return STATE_NAME_TO_CODE[lower] ?? null;
}

/**
 * Get all area codes for a state/province.
 * Returns an array of numbers, or [] if state not found.
 */
function getAreaCodesForState(state) {
  const code = normalizeState(state);
  return code ? STATE_AREA_CODES[code] ?? [] : [];
}

/**
 * Get the primary (most common/first) area code for a state.
 * Returns null if state not recognized.
 */
function getPrimaryAreaCode(state) {
  const codes = getAreaCodesForState(state);
  return codes.length > 0 ? codes[0] : null;
}

/**
 * Suggest an area code from a company's address fields.
 * Prefers: state lookup → null
 */
function suggestAreaCode({ state }) {
  if (state) {
    const code = getPrimaryAreaCode(state);
    if (code) return code;
  }
  return null;
}

module.exports = { getAreaCodesForState, getPrimaryAreaCode, suggestAreaCode, normalizeState };
