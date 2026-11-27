import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/LegalPage";
import { LEGAL } from "@/lib/legal";

export const metadata: Metadata = { title: "Privacy notice · Velza Traceability" };

// Written from what the code stores (src/lib/store/sql/schema.ts, src/lib/security.ts, browser storage keys).
// Update this page whenever a new personal field, log or third-party service is added.

const DATA: { what: string; examples: string; why: string; kept: string }[] = [
  {
    what: "Business and contact details",
    examples: "Business name, contact person, address, city, state, PIN code, phone, email, who supplies you",
    why: "To register you as a partner in the supply chain, route stock to you and contact you",
    kept: "While your account is active, then as long as the law requires for business records",
  },
  {
    what: "Sign-in details",
    examples: "Sign-in ID, name, role, password (stored only as a one-way hash), last sign-in time",
    why: "To let you sign in and to show you only the screens of your role",
    kept: "While your account is active",
  },
  {
    what: "Session cookie",
    examples: "A random token in the velza_session cookie; we store only a hash of it",
    why: "To keep you signed in for up to 12 hours",
    kept: "12 hours, or until you sign out",
  },
  {
    what: "Activity records",
    examples: "Each print, scan, dispatch, receipt, recall and damage report, with your sign-in ID, device, location and time",
    why: "Product traceability, recalls, stock accuracy and fraud prevention",
    kept: "For the life of the product records; these records cannot be edited or deleted, so the chain stays trustworthy",
  },
  {
    what: "Damage photos",
    examples: "Photos you choose to upload with a damage report",
    why: "To verify the damage and decide on returns",
    kept: "As long as the damage report is kept",
  },
  {
    what: "Technical data",
    examples: "Your IP address and browser request details",
    why: "Rate limiting and security logs, to stop abuse and attacks",
    kept: "IP addresses are used in memory; security log lines are kept by our hosting provider for a short period",
  },
];

export default function PrivacyPage() {
  const g = LEGAL.grievanceOfficer;
  return (
    <LegalPage
      title="Privacy notice"
      intro={
        <p>
          This notice explains what personal data Velza Traceability collects, why, how long we keep it and the rights you have. It applies to the
          partner portal and to the public product-check page opened from a QR code. The data fiduciary is {LEGAL.business.legalName} (&quot;Velza&quot;,
          &quot;we&quot;), {LEGAL.business.registeredAddress}.
        </p>
      }
    >
      <LegalSection id="collect" title="1. What we collect and why">
        <div className="overflow-x-auto rounded-control border border-line">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <caption className="sr-only">Personal data we collect</caption>
            <thead className="bg-surface-2">
              <tr>
                <th scope="col" className="p-3 font-semibold">Data</th>
                <th scope="col" className="p-3 font-semibold">Examples</th>
                <th scope="col" className="p-3 font-semibold">Purpose</th>
                <th scope="col" className="p-3 font-semibold">How long we keep it</th>
              </tr>
            </thead>
            <tbody>
              {DATA.map((d) => (
                <tr key={d.what} className="border-t border-line align-top">
                  <th scope="row" className="p-3 font-semibold">{d.what}</th>
                  <td className="p-3">{d.examples}</td>
                  <td className="p-3">{d.why}</td>
                  <td className="p-3">{d.kept}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          <strong>Consumers checking a product:</strong> the QR page stores no name, IP address, account or device for your check. Camera scanning in the
          app reads barcodes inside your browser; camera images are not sent to us unless you upload a damage photo.
        </p>
        <p>We do not sell personal data, show advertising, or use analytics, tracking pixels or third-party embeds.</p>
      </LegalSection>

      <LegalSection id="basis" title="2. Consent and lawful use">
        <p>
          Partners who sign up give consent on the sign-up form. Accounts created by Velza Admin are set up under the partner agreement, and the partner is
          told of this notice. We use data only for the purposes listed above, as permitted by the Digital Personal Data Protection Act, 2023, the
          Information Technology Act, 2000 and the rules made under them.
        </p>
        <p>You may withdraw consent at any time by writing to the Grievance Officer. We will then close your account, except for records the law or product recalls require us to keep.</p>
      </LegalSection>

      <LegalSection id="share" title="3. Who can see your data">
        <ul>
          <li>Velza staff, limited by role (for example, Admin manages partners, HQ sees the whole chain).</li>
          <li>Partners in your chain, only as needed: your supplier sees what it sent you; a Super Stockist or Distributor sees the stock of the partners assigned to it.</li>
          <li>Our hosting and database providers, who process data only on our instructions: currently Vercel and Neon, moving to Amazon Web Services (Mumbai).</li>
          <li>Authorities, when the law requires it.</li>
        </ul>
      </LegalSection>

      <LegalSection id="where" title="4. Where data is stored">
        <p>Our providers may store data outside India, currently in Singapore. After the move to Amazon Web Services it will be stored in Mumbai, India.</p>
      </LegalSection>

      <LegalSection id="security" title="5. How we protect it">
        <ul>
          <li>Encrypted connections (HTTPS) and passwords stored only as one-way hashes.</li>
          <li>Role-based access: every request is checked against your role on the server.</li>
          <li>Sign-in lock after 5 failed attempts, rate limits, and logs that cannot be altered.</li>
          <li>Daily database backups kept for a limited period.</li>
        </ul>
        <p>If a breach affects your data, we will inform you and the Data Protection Board of India as the law requires.</p>
      </LegalSection>

      <LegalSection id="rights" title="6. Your rights">
        <p>You can ask us to:</p>
        <ul>
          <li>tell you what personal data we hold about you and who we shared it with;</li>
          <li>correct or complete it;</li>
          <li>erase it, where we are not required to keep it;</li>
          <li>nominate a person to act for you in case of death or incapacity;</li>
          <li>resolve a grievance about how we handle your data.</li>
        </ul>
        <p>
          Write to the Grievance Officer below. We will reply {g.responseTime}. If you are not satisfied, you may complain to the Data Protection Board of
          India.
        </p>
      </LegalSection>

      <LegalSection id="children" title="7. Children">
        <p>The partner portal is for businesses and their staff aged 18 or over. We do not knowingly collect data about children.</p>
      </LegalSection>

      <LegalSection id="contact" title="8. Grievance Officer and contact">
        <address className="not-italic">
          {g.name}
          <br />
          Grievance Officer, {LEGAL.business.legalName}
          <br />
          {LEGAL.business.registeredAddress}
          <br />
          Email: {g.email}
        </address>
        <p>We will post any change to this notice here with a new version number. If a change affects how we use your data, we will ask for your consent again.</p>
      </LegalSection>
    </LegalPage>
  );
}
