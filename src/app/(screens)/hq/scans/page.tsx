"use client";

import { IconCircleCheck, IconCircleX } from "@/components/icons";
import { Card, Code, Empty, fmtTime, Notice, PageTitle, Table, Td } from "@/components/ui";
import { useApi } from "@/components/useApi";
import type { Scan } from "@/lib/core/types";

export default function ScansPage() {
  const { data, error } = useApi<(Scan & { user: string | null; partner: string | null })[]>("/api/scans", { refreshOnChange: true });
  return (
    <>
      <PageTitle title="Scan audit" subtitle="Every scan, success or failure (latest 300)." />
      {error && <Notice tone="error">{error}</Notice>}
      <Card>
        <Table head={["Time", "Context", "Code", "Result", "Message", "Who"]} empty={data && !data.length ? <Empty>No scans yet</Empty> : null}>
          {data?.map((s) => (
            <tr key={s.id}>
              <Td className="whitespace-nowrap text-muted-foreground">{fmtTime(s.at)}</Td>
              <Td className="text-xs font-semibold uppercase tracking-wide text-foreground-2">{s.context}</Td>
              <Td>
                <Code>{s.code}</Code>
              </Td>
              <Td className="whitespace-nowrap">
                <span className={s.ok ? "inline-flex items-center gap-1.5 text-xs font-bold tracking-wide text-success" : "inline-flex items-center gap-1.5 text-xs font-bold tracking-wide text-danger"}>
                  {s.ok ? <IconCircleCheck size={16} /> : <IconCircleX size={16} />}
                  {s.result}
                </span>
              </Td>
              <Td className="text-xs">{s.message}</Td>
              <Td className="text-xs text-muted-foreground">{s.user ?? "public"}{s.partner && <div>{s.partner}</div>}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
