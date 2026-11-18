// web/src/components/MasterDetail.tsx
import type { ReactNode } from "react";
import { ResizableSplit } from "./ResizableSplit.js";
import "./MasterDetail.css";

export interface MasterDetailProps {
  listSlot: ReactNode;
  detailSlot: ReactNode;
  listPending?: boolean;
  /** localStorage key for the master-list width. */
  storageKey?: string;
  className?: string;
}

export function MasterDetail({
  listSlot,
  detailSlot,
  listPending = false,
  storageKey = "yulu_ui.master.list.width",
  className,
}: MasterDetailProps) {
  return (
    <div className={`masterdetail${className ? ` ${className}` : ""}`}>
      <ResizableSplit
        storageKey={storageKey}
        side="right"
        min={240}
        max={520}
        defaultWidth={360}
      >
        <div className="masterdetail-list">
          {listPending
            ? Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="masterdetail-skeleton" data-testid="masterdetail-skeleton" />
              ))
            : listSlot}
        </div>
      </ResizableSplit>
      <div className="masterdetail-detail">{detailSlot}</div>
    </div>
  );
}
