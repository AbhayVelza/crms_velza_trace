"use client";

import { useState } from "react";
import { useApi } from "@/components/useApi";
import { Button, Card, cx, Empty, fmtTime, Input, Notice, PageTitle, Table, Td } from "@/components/ui";
import { api, errorText } from "@/lib/client";
import type { AccountStatus } from "@/lib/core/auth";
import { ROLE_LABELS, type PublicUser } from "@/lib/core/types";

interface ApprovalRow extends PublicUser {
  status: AccountStatus;
  statusLabel: string;
  partnerName: string | null;
  adminApprovedByName: string | null;
  hqApprovedByName: string | null;
  rejectedByName: string | null;
}

const PENDING: AccountStatus[] = ["PENDING_HQ", "PENDING_ADMIN"];

export default function ApprovalsPage() {
  const list = useApi<ApprovalRow[]>("/api/approvals");
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const rows = list.data ?? [];
  const pending = rows.filter((r) => PENDING.includes(r.status));
  const others = rows.filter((r) => !PENDING.includes(r.status));

  async function act(row: ApprovalRow, action: "approve" | "reject" | "revoke") {
    setMsg(null);
    try {
      await api("/api/approvals", { body: { userId: row.id, action, reason: reasons[row.id] || undefined } });
      setMsg({ tone: "ok", text: `${row.name}: ${action === "approve" ? "approved — they can sign in now" : action === "reject" ? "rejected" : "access revoked"}` });
      list.reload();
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e) });
    }
  }

  const reasonInput = (row: ApprovalRow) => (
    <Input
      aria-label={`Reason for ${row.name}`}
      placeholder="Reason (needed to reject/revoke)"
      value={reasons[row.id] ?? ""}
      onChange={(e) => setReasons({ ...reasons, [row.id]: e.target.value })}
      className="min-w-[12rem]"
    />
  );

  const who = (r: ApprovalRow) => (
    <>
      <div className="font-medium text-slate-900">{r.name}</div>
      <div className="font-mono text-xs text-slate-500">{r.loginId}</div>
    </>
  );

  return (
    <>
      <PageTitle title="Account approvals" subtitle="Partner accounts can sign in only after Velza Admin has set them up and Velza HQ has approved them." />
      <div className="space-y-4">
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        {list.error && <Notice tone="error">{list.error}</Notice>}
        <Card title={`Waiting for approval (${pending.length})`}>
          <Table head={["Person", "Portal", "Partner", "Set up by", "", ""]} empty={pending.length ? null : <Empty>Nothing waiting</Empty>}>
            {pending.map((r) => (
              <tr key={r.id}>
                <Td>{who(r)}</Td>
                <Td>{ROLE_LABELS[r.role]}</Td>
                <Td>{r.partnerName ?? "—"}</Td>
                <Td>
                  {r.adminApprovedByName ?? <span className="text-amber-800">{r.statusLabel}</span>}
                  <div className="text-xs text-slate-500">{fmtTime(r.adminApprovedAt ?? r.createdAt)}</div>
                </Td>
                <Td>{reasonInput(r)}</Td>
                <Td>
                  <div className="flex gap-1">
                    <Button className="min-h-8 px-3 py-1 text-xs" disabled={r.status !== "PENDING_HQ"} onClick={() => act(r, "approve")}>
                      Approve
                    </Button>
                    <Button variant="danger" className="min-h-8 px-3 py-1 text-xs" disabled={!reasons[r.id]} onClick={() => act(r, "reject")}>
                      Reject
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="All partner accounts">
          <Table head={["Person", "Portal", "Partner", "Status", "", ""]} empty={others.length ? null : <Empty>None</Empty>}>
            {others.map((r) => (
              <tr key={r.id}>
                <Td>{who(r)}</Td>
                <Td>{ROLE_LABELS[r.role]}</Td>
                <Td>{r.partnerName ?? "—"}</Td>
                <Td>
                  <span className={cx("rounded px-2 py-0.5 text-xs font-medium", r.status === "APPROVED" ? "bg-green-100 text-green-800" : r.status === "REJECTED" ? "bg-red-100 text-red-800" : "bg-slate-200 text-slate-700")}>
                    {r.statusLabel}
                  </span>
                  {r.status === "APPROVED" && <div className="mt-1 text-xs text-slate-500">by {r.hqApprovedByName} · {fmtTime(r.hqApprovedAt)}</div>}
                  {r.status === "REJECTED" && <div className="mt-1 text-xs text-red-700">“{r.rejectReason}” · {r.rejectedByName}</div>}
                </Td>
                <Td>{r.status === "APPROVED" && reasonInput(r)}</Td>
                <Td>
                  {r.status === "APPROVED" && (
                    <Button variant="secondary" className="min-h-8 px-3 py-1 text-xs" disabled={!reasons[r.id]} onClick={() => act(r, "revoke")}>
                      Revoke
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}
