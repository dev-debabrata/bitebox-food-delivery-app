// Partner verification: documents, bank account and admin review (routes/kyc.routes.js), and a
// restaurant's resubmission after "documents needed".
const ok = (data, description = "Success") => ({
  description,
  content: { "application/json": { schema: { type: "object", properties: { success: { const: true }, message: { type: "string" }, data } } } },
});
const err = (description) => ({ description });
const bearer = [{ bearerAuth: [] }];
const id = { in: "path", name: "id", required: true, schema: { type: "string" } };
const file = { 200: { description: "The document (PDF or image)", content: { "application/octet-stream": {} } }, 404: err("Not found") };
const summary = ok({ type: "object", description: "documents, allowedKinds, checklist, payoutAccount (masked), complete" });

export const kycTags = [{ name: "KYC", description: "Partner documents and bank account; admin review" }];

export const kycPaths = {
  "/kyc": { get: { tags: ["KYC"], summary: "My verification: documents, checklist and bank account", security: bearer, responses: { 200: summary } } },
  "/kyc/documents": {
    post: {
      tags: ["KYC"],
      summary: "Upload a document (PDF, JPEG, PNG or WebP, 5 MB); uploading the same kind again replaces it",
      security: bearer,
      requestBody: { content: { "multipart/form-data": { schema: { type: "object", required: ["kind", "file"], properties: { kind: { type: "string" }, number: { type: "string" }, file: { type: "string", format: "binary" } } } } } },
      responses: { 201: ok({ type: "object" }), 400: err("Wrong number or kind"), 413: err("Too large"), 415: err("Not a PDF or image") },
    },
  },
  "/kyc/documents/{id}": {
    delete: { tags: ["KYC"], summary: "Remove a document that is not approved", security: bearer, parameters: [id], responses: { 200: ok({ type: "null" }), 409: err("Approved") } },
  },
  "/kyc/documents/{id}/file": { get: { tags: ["KYC"], summary: "My document's file", security: bearer, parameters: [id], responses: file } },
  "/kyc/payout-account": {
    put: {
      tags: ["KYC"],
      summary: "Set the bank account BiteBox pays into (stored encrypted; only the last 4 digits come back)",
      security: bearer,
      requestBody: { content: { "application/json": { schema: { type: "object", required: ["holderName", "accountNumber", "ifsc"], properties: { holderName: { type: "string" }, accountNumber: { type: "string" }, ifsc: { type: "string" }, bankName: { type: "string" } } } } } },
      responses: { 200: summary, 400: err("Invalid account number or IFSC") },
    },
  },
  "/admin/kyc/partners/{id}": {
    get: { tags: ["KYC"], summary: "A partner's verification (restaurants:manage or riders:manage)", security: bearer, parameters: [id], responses: { 200: summary, 404: err("Not found") } },
  },
  "/admin/kyc/documents/{id}": {
    patch: {
      tags: ["KYC"],
      summary: "Approve or reject a document (a rejection needs a note, sent to the partner)",
      security: bearer,
      parameters: [id],
      requestBody: { content: { "application/json": { schema: { type: "object", required: ["status"], properties: { status: { enum: ["approved", "rejected"] }, note: { type: "string" } } } } } },
      responses: { 200: ok({ type: "object" }), 400: err("Note missing") },
    },
  },
  "/admin/kyc/documents/{id}/file": { get: { tags: ["KYC"], summary: "View a document (audited)", security: bearer, parameters: [id], responses: file } },
  "/delivery/me/details": {
    patch: {
      tags: ["KYC"],
      summary: "The rider's home address (needed for verification)",
      security: bearer,
      requestBody: { content: { "application/json": { schema: { type: "object", required: ["address"], properties: { address: { type: "object" } } } } } },
      responses: { 200: ok({ type: "object" }), 422: err("Validation failed") },
    },
  },
  "/delivery/me/resubmit": {
    post: { tags: ["KYC"], summary: "Send the rider's verification for review again", security: bearer, responses: { 200: ok({ type: "object" }), 409: err("Not waiting for changes") } },
  },
  "/admin/delivery-partners/{id}": {
    get: { tags: ["KYC"], summary: "A rider with their profile and verification (riders:manage)", security: bearer, parameters: [id], responses: { 200: ok({ type: "object" }), 404: err("Not found") } },
  },
  "/admin/delivery-partners/{id}/verification": {
    patch: {
      tags: ["KYC"],
      summary: "Approve a rider (409 KYC_INCOMPLETE until documents, bank account and address are in), ask for documents, or reject",
      security: bearer,
      parameters: [id],
      requestBody: { content: { "application/json": { schema: { type: "object", required: ["status"], properties: { status: { enum: ["approved", "rejected", "resubmission_requested"] }, reason: { type: "string" } } } } } },
      responses: { 200: ok({ type: "object" }), 400: err("Reason missing"), 409: err("Not allowed or incomplete") },
    },
  },
  "/my/restaurant/resubmit": {
    post: { tags: ["KYC"], summary: "Send the restaurant for review again after changes were asked for", security: bearer, responses: { 200: ok({ type: "object" }), 409: err("Not waiting for changes") } },
  },
};
