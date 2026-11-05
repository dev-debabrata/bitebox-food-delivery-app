import mongoose from "mongoose";

/** One important admin action: who did what to which record, and when. Append-only. */
const auditLogSchema = new mongoose.Schema(
  {
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    adminRole: { type: String, required: true },
    action: { type: String, required: true, maxlength: 60 }, // e.g. "order.cancel"
    description: { type: String, required: true, maxlength: 500 },
    resourceType: { type: String, maxlength: 40 },
    resourceId: { type: String, maxlength: 64 },
    ip: { type: String, maxlength: 64 },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = String(ret._id);
        delete ret._id;
        return ret;
      },
    },
  },
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ admin: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ resourceId: 1, createdAt: -1 });

export const AuditLog = mongoose.model("AuditLog", auditLogSchema);
