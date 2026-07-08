// Daily renewal-alert check, run by .github/workflows/alerts.yml
// Uses the Supabase service role key (bypasses RLS) — never expose this key client-side.
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ALERT_EMAIL_FROM = process.env.ALERT_EMAIL_FROM || 'Contract Tracker <alerts@sandboxvr.com>';
const ALERT_EMAIL_RECIPIENTS = (process.env.ALERT_EMAIL_RECIPIENTS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing required SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY secret.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function daysUntil(dateStr) {
  const target = new Date(dateStr + 'T00:00:00Z');
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}

// The date that actually matters: renewal_deadline minus notice_period_days, if set.
function relevantDeadline(contract) {
  if (!contract.notice_period_days || !contract.renewal_deadline) return contract.renewal_deadline;
  const d = new Date(contract.renewal_deadline + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - contract.notice_period_days);
  return d.toISOString().slice(0, 10);
}

function buildMessage(contract, deadline, days, owners) {
  const ownerNames = owners.map((o) => o.name).join(', ') || 'Unassigned';
  const value = contract.total_value
    ? `$${Number(contract.total_value).toLocaleString('en-US')}`
    : 'unknown value';
  return `${contract.contract_ref} (${contract.supplier || 'unknown supplier'}) — ${value} renews in ${days} days (${deadline}). Owners: ${ownerNames}. Stage: ${contract.renewal_stage || 'Not started'}.`;
}

async function hasAlreadySent(contractId, thresholdDays, channel) {
  const { data, error } = await supabase
    .from('alert_log')
    .select('id')
    .eq('contract_id', contractId)
    .eq('threshold_days', thresholdDays)
    .eq('channel', channel)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

async function logAlert(contractId, thresholdDays, channel) {
  const { error } = await supabase
    .from('alert_log')
    .insert({ contract_id: contractId, threshold_days: thresholdDays, channel });
  if (error) throw error;
}

async function sendSlack(text) {
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `:rotating_light: Contract renewal alert\n${text}` }),
  });
  if (!res.ok) throw new Error(`Slack webhook failed: ${res.status} ${await res.text()}`);
}

async function sendEmail(contract, message, recipients) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: ALERT_EMAIL_FROM,
      to: recipients,
      subject: `Contract renewal alert: ${contract.contract_ref}`,
      text: message,
    }),
  });
  if (!res.ok) throw new Error(`Resend API failed: ${res.status} ${await res.text()}`);
}

async function main() {
  // "Pending" means the contract is live and being paid for — a renewal decision is pending,
  // not the contract itself — so it still needs renewal alerts.
  const { data: contracts, error: contractsError } = await supabase
    .from('contracts')
    .select('*, contract_owners(owners(name,email))')
    .in('status', ['active', 'pending']);
  if (contractsError) throw contractsError;

  const { data: thresholds, error: thresholdsError } = await supabase
    .from('alert_thresholds')
    .select('*')
    .eq('enabled', true);
  if (thresholdsError) throw thresholdsError;

  if (!SLACK_WEBHOOK_URL) console.log('SLACK_WEBHOOK_URL not set — skipping Slack alerts.');
  if (!RESEND_API_KEY) console.log('RESEND_API_KEY not set — skipping email alerts.');

  let sentCount = 0;

  for (const contract of contracts) {
    const deadline = relevantDeadline(contract);
    if (!deadline) continue;
    const days = daysUntil(deadline);

    for (const threshold of thresholds) {
      if (days !== threshold.days_before) continue;

      const owners = (contract.contract_owners ?? []).map((co) => co.owners).filter(Boolean);
      const message = buildMessage(contract, deadline, days, owners);

      if (SLACK_WEBHOOK_URL && !(await hasAlreadySent(contract.id, threshold.days_before, 'slack'))) {
        await sendSlack(message);
        await logAlert(contract.id, threshold.days_before, 'slack');
        sentCount++;
      }

      // Recipients = this contract's actual owners, plus the global fallback/CC list (deduped).
      const recipients = [...new Set([...owners.map((o) => o.email), ...ALERT_EMAIL_RECIPIENTS])];

      if (RESEND_API_KEY && recipients.length && !(await hasAlreadySent(contract.id, threshold.days_before, 'email'))) {
        await sendEmail(contract, message, recipients);
        await logAlert(contract.id, threshold.days_before, 'email');
        sentCount++;
      }
    }
  }

  console.log(`Done. ${sentCount} alert(s) sent.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
