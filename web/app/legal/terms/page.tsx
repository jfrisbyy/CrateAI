export const metadata = { title: "Terms of service" };

export default function TermsPage() {
  return (
    <>
      <h1>Terms of service</h1>
      <p>These terms cover your use of CrateAI, a hosted workspace for analyzing and preparing audio you already have the right to use. TODO(owner): replace &ldquo;the operator&rdquo; with the legal entity name and add the governing law.</p>
      <h2>What you upload</h2>
      <ul>
        <li>You upload only audio you own or have the right to use, and you keep every right you hold in it.</li>
        <li>The service processes your audio solely for you: it measures it, separates it, chops it, renders loops and layers from it, and returns the results to your library. It never publishes your audio, never shares it with other users, and never trains models on it.</li>
        <li>You are responsible for what you do with the outputs. A loop or a chop of a recording you do not own is still that recording.</li>
      </ul>
      <h2>What the service does not do</h2>
      <ul>
        <li>It does not download or process audio or video from links, streams, or other platforms. Uploads are the only way audio enters the service.</li>
        <li>It does not generate music from text. Every output is derived from audio you brought.</li>
      </ul>
      <h2>Accounts and plans</h2>
      <ul>
        <li>The free plan is capped by storage, GPU minutes, chat turns, and web searches; the caps are shown on your account page.</li>
        <li>Paid plans renew monthly through Stripe and can be canceled any time from the billing portal; access continues to the end of the paid period.</li>
        <li>You may delete your files and your account at any time; deleted audio is removed from storage within 30 days of the request and from backups within 90.</li>
      </ul>
      <h2>Copyright complaints</h2>
      <p>Notices of claimed infringement go through the process on the <a href="/legal/dmca" className="text-pad">copyright page</a>. Accounts that receive repeated valid notices are closed.</p>
      <h2>Availability and liability</h2>
      <p>The service is provided as is. Measurements carry confidence values and can be wrong; the service does not warrant the accuracy of any analysis. To the extent allowed by law, the operator&rsquo;s liability is limited to the fees you paid in the twelve months before a claim.</p>
      <h2>Changes</h2>
      <p>Material changes to these terms are announced in the app at least 14 days before they apply.</p>
    </>
  );
}
