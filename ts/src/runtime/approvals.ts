import { ApprovalService } from "../governance/index.js";
import { PromotionService } from "../memory/index.js";
import { OrgChangeService } from "../org/index.js";
import type { Database } from "../persistence/index.js";

export function createApprovalServiceWithApplications(database: Database): ApprovalService {
  return new ApprovalService(database, {
    applyWithoutRun: (approval) => {
      if (approval.payload.target_type === "promotion_candidate") {
        // The v0 demo promotion is approved without corroboration, so this
        // application path opts into the 0 corroboration floor explicitly
        // (#101 default is 1).
        new PromotionService(database, { min_corroboration: 0 }).ratifyAndWriteCollective(
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
