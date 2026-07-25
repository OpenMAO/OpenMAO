import { ApprovalService } from "../governance/index.js";
import { PromotionService } from "../memory/index.js";
import { OrgChangeService } from "../org/index.js";
import type { Database } from "../persistence/index.js";

export function createApprovalServiceWithApplications(database: Database): ApprovalService {
  return new ApprovalService(database, {
    applyWithoutRun: (approval) => {
      if (approval.payload.target_type === "promotion_candidate") {
        // Production promotions into collective memory require at least one independent
        // corroboration (a distinct actor). The deterministic spine demo path constructs its own
        // PromotionService and is intentionally unaffected.
        new PromotionService(database, { min_corroboration: 1 }).ratifyAndWriteCollective(
          approval.payload.target_id,
          {
            workspace_id: approval.workspace_id,
            approval_id: approval.id,
            resolved_at: approval.resolved_at,
          },
        );
        return;
      }
      if (approval.payload.target_type === "org_change_proposal") {
        new OrgChangeService(database).approveFromApproval(approval);
        return;
      }
      throw new Error(`unsupported approval target: ${approval.payload.target_type}`);
    },
  });
}
