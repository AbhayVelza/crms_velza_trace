"use client";

import { AdminCrud } from "@/components/AdminCrud";
import { PageTitle } from "@/components/ui";

export default function ReferencePage() {
  return (
    <>
      <PageTitle title="Countries & flavours" subtitle="These codes are printed inside every lot code, so existing codes can't be changed — only deactivated." />
      <div className="grid gap-6 lg:grid-cols-2">
        <AdminCrud
          entity="countries"
          title="Countries"
          columns={[
            { key: "code", label: "Code", type: "text", createOnly: true, placeholder: "2 digits, e.g. 91" },
            { key: "name", label: "Name", type: "text", placeholder: "Country" },
            { key: "active", label: "Active", type: "bool" },
          ]}
        />
        <AdminCrud
          entity="flavours"
          title="Flavours"
          columns={[
            { key: "code", label: "Code", type: "text", createOnly: true, placeholder: "2 letters, e.g. OR" },
            { key: "name", label: "Name", type: "text", placeholder: "Flavour" },
            { key: "active", label: "Active", type: "bool" },
          ]}
        />
      </div>
    </>
  );
}
