"use client";

import { AdminCrud } from "@/components/AdminCrud";
import { useSession } from "@/components/session";
import { PageTitle } from "@/components/ui";

export default function DevicesPage() {
  const { data } = useSession();
  const manufacturers = (data?.partners ?? []).filter((p) => p.type === "MANUFACTURER");
  return (
    <>
      <PageTitle title="Devices" subtitle="Manufacturer PCs that run the print wizard. Offline devices can only use codes already in their pool." />
      <AdminCrud
        entity="devices"
        title="Devices"
        columns={[
          { key: "manufacturerId", label: "Manufacturer", type: "select", createOnly: true, options: () => manufacturers.map((m) => ({ value: m.id, label: m.name })) },
          { key: "name", label: "Name", type: "text", placeholder: "e.g. Pune Line-2 PC" },
          { key: "offline", label: "Offline", type: "bool", defaultValue: false },
        ]}
      />
    </>
  );
}
