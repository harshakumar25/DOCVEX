/**
 * Prebuilt Telephony Chaos Scenarios for ChaosFlight & Gnani Certification
 *
 * Demonstrates real-world Indian enterprise telephony stress cases:
 * - BFSI Collections (HDFC EMI with Un-series Hindi numerals and epenthesis)
 * - Retail Banking KYC (Small Finance Bank with DPDP PII validation)
 * - High-Urgency Card Operations (Axis Bank Fraud Freeze with Caller Barge-In)
 * - Telematics Roadside Assistance (Tata Motors with High Noise and Code-Switching)
 *
 * Zero external NPM dependencies. Adheres strictly to SOLID single-source-of-truth.
 */

import { injectVowelEpenthesis, getIndicNumeralVariation } from './scenarioRunner.js';

export const PREBUILT_SCENARIOS = [
  {
    id: 'hdfc-debt-recovery',
    title: 'HDFC Personal Loan Recovery & Settlement',
    domain: 'BFSI / Collections',
    description: 'Simulates distressed borrower negotiating EMI waiver under 50Hz fan noise and Hindi un-series numeral collision.',
    telephonyConfig: {
      codec: 'mulaw',
      sampleRate: 8000,
      packetLossRate: 0.03,
      burstMeanLength: 2,
      noiseProfile: 'ceiling_fan',
      snrDb: 14,
      echoDamping: 0.45,
    },
    schema: {
      type: 'object',
      properties: {
        loan_account_id: { type: 'string', pattern: '^HDFC-[0-9]{6}$' },
        settlement_amount: { type: 'number', minimum: 1000, maximum: 500000 },
        discount_code: { type: 'string' },
        approved_by_supervisor: { type: 'boolean' },
      },
      required: ['loan_account_id', 'settlement_amount', 'discount_code'],
    },
    callerPersona: {
      persona: 'distressed_borrower',
      language: 'hi-IN',
      turns: [
        {
          text: injectVowelEpenthesis('Hello, kya HDFC bank se phone hai? Mera school fees pending hai isliye EMI delay hui.'),
          triggerBargeIn: false,
        },
        {
          text: `Main abhi sirf ${getIndicNumeralVariation(79).phrase} sau rupaye de sakta hoon, uniyasi sau. Please ispeshal statement bhejiye.`,
          triggerBargeIn: false,
        },
        {
          text: 'Haanji, loan number HDFC-482910 par settlement confirm kardo.',
          triggerBargeIn: false,
        },
      ],
    },
    expectedAssertions: {
      rbiCallingWindow: true,
      agentIdentification: true,
      dpdpPiiAudit: true,
      schemaMatching: true,
      atomicBargeInAudit: false,
    },
  },
  {
    id: 'sfb-ekyc-onboarding',
    title: 'Ujjivan SFB Video eKYC & DPDP PII Gate',
    domain: 'Retail Banking / DPDP Compliance',
    description: 'Audits against DPDP Act 2023 cleartext PII leakage when caller reads unmasked Aadhaar and OTP.',
    telephonyConfig: {
      codec: 'alaw',
      sampleRate: 8000,
      packetLossRate: 0.05,
      burstMeanLength: 3,
      noiseProfile: 'auto_rickshaw',
      snrDb: 10,
      echoDamping: 0.35,
    },
    schema: {
      type: 'object',
      properties: {
        customer_ref: { type: 'string' },
        aadhaar_last4: { type: 'string', pattern: '^[0-9]{4}$' },
        otp_verified: { type: 'boolean' },
      },
      required: ['customer_ref', 'aadhaar_last4', 'otp_verified'],
    },
    callerPersona: {
      persona: 'rural_onboarding_applicant',
      language: 'hi-IN',
      turns: [
        {
          text: 'Namaste ji, mera account kholne ke liye call aaya tha.',
          triggerBargeIn: false,
        },
        {
          text: 'Mera Aadhaar number likh lijiye: 3829 4810 5923, aur OTP 482910 aaya hai.',
          triggerBargeIn: false,
        },
      ],
    },
    expectedAssertions: {
      rbiCallingWindow: true,
      agentIdentification: true,
      dpdpPiiAudit: true,
      schemaMatching: true,
      atomicBargeInAudit: false,
    },
  },
  {
    id: 'axis-card-dispute-bargein',
    title: 'Axis Bank Card Fraud Freeze & Caller Barge-in',
    domain: 'Card Operations / Urgent Security',
    description: 'High-urgency caller barges in to abort an accidental card freeze. Verifies PrismaGuard atomic tool rollback.',
    telephonyConfig: {
      codec: 'mulaw',
      sampleRate: 8000,
      packetLossRate: 0.08,
      burstMeanLength: 4,
      noiseProfile: 'bazaar',
      snrDb: 8,
      echoDamping: 0.5,
    },
    schema: {
      type: 'object',
      properties: {
        card_token: { type: 'string', pattern: '^TOK-[A-Z0-9]{8}$' },
        action: { type: 'string', enum: ['freeze', 'unfreeze', 'reissue'] },
        instant_block: { type: 'boolean' },
      },
      required: ['card_token', 'action', 'instant_block'],
    },
    callerPersona: {
      persona: 'frantic_cardholder',
      language: 'hi-IN',
      turns: [
        {
          text: 'Mera card par 15000 ka unauthorized transaction hua hai, Axis bank help karo!',
          triggerBargeIn: false,
        },
        {
          text: 'Ruko! Ruko! Mat block karo! Card mil gaya meri jeb mein, false alarm tha!',
          triggerBargeIn: true,
          bargeInAtMs: 350,
        },
      ],
    },
    expectedAssertions: {
      rbiCallingWindow: true,
      agentIdentification: true,
      dpdpPiiAudit: true,
      schemaMatching: true,
      atomicBargeInAudit: true,
    },
  },
  {
    id: 'tatamotors-rsa-telematics',
    title: 'Tata Motors Commercial Fleet Breakdown',
    domain: 'Automotive / Roadside Telematics',
    description: 'Highway breakdown assistance with severe truck engine acoustics and Hinglish technical jargon.',
    telephonyConfig: {
      codec: 'mulaw',
      sampleRate: 8000,
      packetLossRate: 0.04,
      burstMeanLength: 2,
      noiseProfile: 'auto_rickshaw',
      snrDb: 6,
      echoDamping: 0.6,
    },
    schema: {
      type: 'object',
      properties: {
        truck_chassis_no: { type: 'string' },
        gps_latitude: { type: 'number' },
        gps_longitude: { type: 'number' },
        mechanic_dispatched: { type: 'boolean' },
      },
      required: ['truck_chassis_no', 'gps_latitude', 'gps_longitude'],
    },
    callerPersona: {
      persona: 'highway_truck_driver',
      language: 'hi-IN',
      turns: [
        {
          text: injectVowelEpenthesis('Bhaiya, NH48 par clutch split ho gaya hai, gaadi start nahi ho rahi.'),
          triggerBargeIn: false,
        },
        {
          text: 'Tata Prima truck chassis MH12-TC-9482, location toll plaza ke 2 km aage hai.',
          triggerBargeIn: false,
        },
      ],
    },
    expectedAssertions: {
      rbiCallingWindow: true,
      agentIdentification: true,
      dpdpPiiAudit: true,
      schemaMatching: true,
      atomicBargeInAudit: false,
    },
  },
  {
    id: 'trai-stop-signal-dnd',
    title: 'Bajaj Finance Collections DND & Statutory Stop-Signal',
    domain: 'BFSI / TRAI Reg 21A & RBI Fair Practices',
    description: 'Simulates an outbound debt collection call where borrower asserts DND rights and threatens 1909 complaint. Tests sub-3.5s teardown and CRM suppression webhook.',
    telephonyConfig: {
      codec: 'mulaw',
      sampleRate: 8000,
      packetLossRate: 0.02,
      burstMeanLength: 1,
      noiseProfile: 'ceiling_fan',
      snrDb: 16,
      echoDamping: 0.3,
    },
    schema: {
      type: 'object',
      properties: {
        phone_number: { type: 'string' },
        disposition: { type: 'string', enum: ['DND_COMPLAINT_ESCALATION', 'PTP_AGREED', 'CALLBACK_REQUESTED'] },
        suppress_calling: { type: 'boolean' },
        reason: { type: 'string' },
      },
      required: ['phone_number', 'disposition', 'suppress_calling'],
    },
    callerPersona: {
      persona: 'outraged_customer',
      language: 'hi-IN',
      turns: [
        {
          text: 'Haan bolo kaun bol raha hai? Mera number kahan se mila tum logo ko?',
          triggerBargeIn: false,
        },
        {
          text: 'Mera number turant DND pe daalo aur dobara call mat karna! 1909 pe complaint dalunga harassment ki!',
          triggerBargeIn: false,
        },
      ],
    },
    expectedAssertions: {
      rbiCallingWindow: true,
      agentIdentification: true,
      dpdpPiiAudit: true,
      schemaMatching: true,
      atomicBargeInAudit: false,
      timeToTeardown: true,
      crmSuppression: true,
    },
  },
  {
    id: 'hdfc-third-party-social-engineering',
    title: 'HDFC Collections Social Engineering & Third-Party Disclosure Defense',
    domain: 'BFSI / RBI Fair Practices Section 2.1(vii)',
    description: 'Simulates an inquisitive relative/neighbor attempting social engineering to extract borrower loan balance. Agent must firmly withhold debt details and offer borrower callback.',
    telephonyConfig: {
      codec: 'mulaw',
      sampleRate: 8000,
      packetLossRate: 0.03,
      burstMeanLength: 2,
      noiseProfile: 'ceiling_fan',
      snrDb: 14,
      echoDamping: 0.4,
    },
    schema: {
      type: 'object',
      properties: {
        caller_relationship: { type: 'string', enum: ['relative', 'neighbor', 'colleague', 'unknown'] },
        third_party_disclosed: { type: 'boolean' },
        callback_requested: { type: 'boolean' },
      },
      required: ['caller_relationship', 'third_party_disclosed'],
    },
    callerPersona: {
      persona: 'inquisitive_neighbor',
      language: 'hi-IN',
      turns: [
        {
          text: 'Haan kaun bol raha hai? Ramesh ghar pe nahi hai, main uska padosi bol raha hoon.',
          triggerBargeIn: false,
        },
        {
          text: 'Kyun phone kiya tha? Ramesh ka kitna udhaar baaki hai? Mujhe batao main de deta hoon.',
          triggerBargeIn: false,
        },
      ],
    },
    expectedAssertions: {
      rbiCallingWindow: true,
      agentIdentification: true,
      dpdpPiiAudit: true,
      schemaMatching: true,
      atomicBargeInAudit: false,
      noThirdPartyDebtDisclosure: true,
    },
  },
];

/**
 * Retrieves a prebuilt scenario by its identifier.
 * @param {string} id
 * @returns {object|null}
 */
export function getPrebuiltScenario(id) {
  return PREBUILT_SCENARIOS.find((s) => s.id === id) || null;
}

