import { redirect } from "next/navigation";
import { AccountPanel } from "@/components/account/AccountPanel";
import { stripeEnv } from "@/lib/billing/stripe";
import { getProfile, getUsage } from "@/lib/billing/usage";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const [profile, usage] = await Promise.all([getProfile(supabase, user.id), getUsage(supabase, user.id)]);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-xl px-6 py-8">
        <h1 className="mb-6 text-xl">Account</h1>
        <AccountPanel profile={{ ...profile, email: profile.email ?? user.email ?? null }} usage={usage} billingConfigured={stripeEnv().configured} />
      </div>
    </div>
  );
}
