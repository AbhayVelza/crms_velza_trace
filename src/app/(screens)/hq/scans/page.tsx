"use client";

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
              <Td className="whitespace-nowrap">{fmtTime(s.at)}</Td>
              <Td className="text-xs">{s.context}</Td>
              <Td>
                <Code>{s.code}</Code>
              </Td>
              <Td className={s.ok ? "font-semibold text-green-700" : "font-semibold text-red-700"}>{s.result}</Td>
              <Td className="text-xs">{s.message}</Td>
              <Td className="text-xs text-slate-600">{s.user ?? "public"}{s.partner && <div>{s.partner}</div>}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
