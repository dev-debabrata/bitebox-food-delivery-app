/** Partner verification (GET /kyc, /admin/kyc/partners/{id}). */
export type DocumentStatus = 'pending' | 'approved' | 'rejected';

export interface KycDocument {
  id: string;
  kind: string;
  label: string;
  /** Last 4 characters of the number on the document; the rest is never sent. */
  numberLast4: string | null;
  contentType: string;
  size: number;
  status: DocumentStatus;
  reviewNote: string | null;
  uploadedAt: string;
  reviewedAt: string | null;
}

export interface PayoutAccount {
  holderName: string;
  accountLast4: string;
  ifsc: string;
  bankName: string | null;
  updatedAt: string;
}

export interface KycSummary {
  documents: KycDocument[];
  allowedKinds: { kind: string; label: string }[];
  /** What this partner must have approved (null: not uploaded yet). */
  checklist: { kind: string; label: string; status: DocumentStatus | null }[];
  payoutAccount: PayoutAccount | null;
  /** Every required document approved and a bank account added. */
  complete: boolean;
}

export interface PayoutAccountInput {
  holderName: string;
  accountNumber: string;
  ifsc: string;
  bankName?: string;
}

/** Kinds with a number printed on them (the API checks the format). */
export const NUMBER_HINTS: Record<string, string> = {
  fssai_licence: '14-digit FSSAI number',
  gst_certificate: '15-character GSTIN',
  pan_card: 'PAN, e.g. ABCDE1234F',
  driving_licence: 'Licence number',
  vehicle_rc: 'Registration number',
  id_proof: 'ID number',
};

export const DOCUMENT_TONE: Record<DocumentStatus, string> = {
  pending: 'tone-warn',
  approved: 'tone-good',
  rejected: 'tone-bad',
};
export const DOCUMENT_LABEL: Record<DocumentStatus, string> = {
  pending: 'In review',
  approved: 'Approved',
  rejected: 'Needs a new upload',
};
