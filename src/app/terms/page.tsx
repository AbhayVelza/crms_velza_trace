import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/LegalPage";
import { LEGAL } from "@/lib/legal";

export const metadata: Metadata = { title: "Terms of use · Velza Traceability" };

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of use"
      intro={
        <p>
          These terms apply to everyone who uses Velza Traceability: Velza staff, plant and warehouse users, Super Stockists, Distributors, Retailers and
          consumers checking a product. By signing in or signing up you accept them. A separate distribution agreement with Velza, where one exists, takes
          priority over these terms.
        </p>
      }
    >
      <LegalSection id="service" title="1. The service">
        <p>
          Velza Traceability records where each Velza case, tray and pack is in the supply chain, from the plant to the retailer, so that stock can be
          tracked, counterfeit codes detected and products recalled. The public product check shows only whether a code is registered and its basic product
          details.
        </p>
      </LegalSection>

      <LegalSection id="accounts" title="2. Accounts">
        <ul>
          <li>Keep your sign-in ID and password secret. You are responsible for actions taken with your sign-in.</li>
          <li>Each person uses their own sign-in. Tell Velza Admin at once if you think someone else has used yours.</li>
          <li>Self sign-ups by Super Stockists and Distributors start only after Velza approves them.</li>
          <li>Velza may suspend or close an account that breaks these terms or is no longer part of the chain.</li>
        </ul>
      </LegalSection>

      <LegalSection id="use" title="3. Correct use">
        <p>You agree to:</p>
        <ul>
          <li>scan and record only stock you actually handle, at the time you handle it;</li>
          <li>not copy, forge, alter or reuse codes or stickers;</li>
          <li>report damage truthfully and upload only photos of the product;</li>
          <li>not try to access screens or data outside your role, overload the service, or test its security without written permission.</li>
        </ul>
      </LegalSection>

      <LegalSection id="records" title="4. Records">
        <p>
          Every movement is stored in a log that cannot be changed afterwards. Velza relies on these records for stock, recalls and disputes, so a wrong scan
          must be corrected through the app or reported to Velza, never worked around.
        </p>
      </LegalSection>

      <LegalSection id="ip" title="5. Ownership">
        <p>
          The Velza name, logo and the software belong to {LEGAL.business.legalName}. You may use them only to run your part of the Velza supply chain.
          Open-source components keep their own licences (section 8).
        </p>
      </LegalSection>

      <LegalSection id="liability" title="6. Availability and liability">
        <p>
          We work to keep the service available and correct, but it may be interrupted for maintenance or faults. To the extent the law allows, Velza is not
          liable for indirect loss caused by an interruption or by data entered wrongly by a user. Nothing in these terms limits rights you have under the
          Consumer Protection Act, 2019.
        </p>
      </LegalSection>

      <LegalSection id="law" title="7. Law, changes and contact">
        <p>
          These terms are governed by the laws of India, and the courts at {LEGAL.jurisdiction} have jurisdiction. We will post changes here with a new
          version number. Questions and complaints: {LEGAL.grievanceOfficer.name}, Grievance Officer, {LEGAL.grievanceOfficer.email}. How we handle personal
          data is described in the <a href="/privacy">privacy notice</a>.
        </p>
      </LegalSection>

      <LegalSection id="credits" title="8. Open-source components">
        <ul>
          <li>Fonts: Inter, JetBrains Mono and Open Sans, under the SIL Open Font License 1.1, served from our own server.</li>
          <li>Icons based on Lucide (ISC licence).</li>
          <li>Barcodes drawn with bwip-js (MIT licence); camera scanning with ZXing (Apache License 2.0).</li>
          <li>Built with Next.js and React (MIT licence).</li>
        </ul>
      </LegalSection>
    </LegalPage>
  );
}
