import { Globe } from "lucide-react";
import { ComingSoonStub } from "@/components/dashboard/ComingSoonStub";

export default function DomainsPage() {
  return (
    <ComingSoonStub
      icon={Globe}
      title="Custom domains coming soon"
      description="Attaching your own domain to a project isn't built yet — CustomDomain already exists in the schema, but there's no verification or SSL flow wired up to it."
    />
  );
}
