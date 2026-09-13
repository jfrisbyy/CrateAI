import { TakedownForm } from "@/components/legal/TakedownForm";

export const metadata = { title: "Copyright notices" };

export default function DmcaPage() {
  return (
    <>
      <h1>Copyright notices</h1>
      <p>Audio on CrateAI is private to the account that uploaded it; nothing is published. If you believe an account is processing a work you own without permission, send a notice under the DMCA (17 U.S.C. § 512) with the form below or to the designated agent.</p>
      <h2>Designated agent</h2>
      <p>TODO(owner): agent name, entity, postal address, email, as registered at dmca.copyright.gov (registration renews every three years).</p>
      <h2>What happens next</h2>
      <ul>
        <li>We log the notice, confirm receipt by email, and review it within 2 business days.</li>
        <li>A valid notice leads to removal of the material and a notification to the account holder, who may send a counter-notice.</li>
        <li>After a counter-notice, the material is restored in 10 to 14 business days unless you tell us you have filed for a court order.</li>
        <li>Accounts that receive repeated valid notices are closed.</li>
      </ul>
      <h2>Send a notice</h2>
      <TakedownForm />
    </>
  );
}
