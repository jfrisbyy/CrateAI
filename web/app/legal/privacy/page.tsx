export const metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return (
    <>
      <h1>Privacy</h1>
      <p>What CrateAI stores, why, and who can see it. TODO(owner): add the legal entity, the contact address, and the data-protection contact.</p>
      <h2>Your audio</h2>
      <ul>
        <li>Uploaded audio and everything derived from it (stems, chops, loops, layers, re-voiced parts, MIDI) is stored in a private bucket under a prefix that belongs to your account only. Playback and downloads use signed links that expire after ten minutes.</li>
        <li>No other user can list, play, or download your audio. There are no public links.</li>
        <li>Compute jobs download your audio to a temporary container to measure it and delete it when the job ends.</li>
      </ul>
      <h2>Your analysis and corrections</h2>
      <ul>
        <li>Every measurement is stored with the file so the workspace can show it. When you correct a value, the prediction and the correction are logged to keep the analysis honest; that log is used only to measure and improve accuracy, is scoped to your account, and never crosses users unless you opt in on the account page.</li>
      </ul>
      <h2>Chat</h2>
      <ul>
        <li>Chat messages are stored in your account so conversations persist. Messages, the measurements of files you attach, and the web results the assistant fetches are sent to the language-model provider to produce replies. Your audio bytes are never sent to the language model.</li>
        <li>Web searches run through a search provider; the query text is sent, your identity is not.</li>
      </ul>
      <h2>Billing</h2>
      <p>Payments are handled by Stripe. CrateAI stores your Stripe customer and subscription identifiers and your plan, not card details.</p>
      <h2>Retention and deletion</h2>
      <p>Files you delete are removed from storage immediately and from backups within 90 days. Deleting your account removes your files, analysis, chat, and corrections.</p>
      <h2>Contact</h2>
      <p>TODO(owner): privacy contact email.</p>
    </>
  );
}
