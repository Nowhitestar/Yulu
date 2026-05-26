// web/src/components/MasterDetail.tsx
import type { ReactNode } from "react";
import "./MasterDetail.css";

export interface MasterDetailProps {
  listSlot: ReactNode;
  detailSlot: ReactNode;
  listPending?: boolean;
}

export function MasterDetail({ listSlot, detailSlot, listPending = false }: MasterDetailProps) {
  return (
    <div className="masterdetail">
      <div className="masterdetail-list" data-width="220">
        {listPending
          ? Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="masterdetail-skeleton" data-testid="masterdetail-skeleton" />
            ))
          : listSlot}
      </div>
      <div className="masterdetail-detail">{detailSlot}</div>
    </div>
  );
}
