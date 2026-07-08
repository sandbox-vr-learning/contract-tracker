// All Supabase DB operations live here — app.js should never call supabase.* directly.
import { supabase } from './supabase.js';

// ---------- Auth ----------

export async function dbGetSession() {
  const { data } = await supabase.auth.getSession();
  return data.session ?? null;
}

export function dbOnAuthStateChange(callback) {
  return supabase.auth.onAuthStateChange((_event, session) => callback(session));
}

export async function dbSignInWithEmail(email) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href },
  });
  if (error) throw error;
}

export async function dbSignOut() {
  await supabase.auth.signOut();
}

export async function dbGetCurrentUserRole(email) {
  if (!email) return null;
  const { data, error } = await supabase
    .from('user_roles')
    .select('role')
    .eq('email', email)
    .maybeSingle();
  if (error) throw error;
  return data?.role ?? null;
}

// ---------- Contracts ----------

// Returns contracts with owners nested as [{ id, name, email }] and category_name flattened
export async function dbFetchContracts() {
  const { data, error } = await supabase
    .from('contracts')
    .select(`
      *,
      contract_owners ( owners ( id, name, email ) ),
      categories ( id, name )
    `)
    .order('renewal_deadline', { ascending: true });
  if (error) throw error;
  return data.map((row) => ({
    ...row,
    owners: (row.contract_owners ?? []).map((co) => co.owners).filter(Boolean),
    category_name: row.categories?.name ?? null,
    contract_owners: undefined,
    categories: undefined,
  }));
}

export async function dbUpsertContract(contract) {
  const { id, owners, ...fields } = contract;
  const payload = id ? { id, ...fields } : fields;
  const { data, error } = await supabase
    .from('contracts')
    .upsert(payload)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function dbDeleteContract(id) {
  const { error } = await supabase.from('contracts').delete().eq('id', id);
  if (error) throw error;
}

// ---------- Owners ----------

export async function dbFetchOwners() {
  const { data, error } = await supabase.from('owners').select('*').order('name');
  if (error) throw error;
  return data;
}

// Finds an existing owner by email or creates one. Used by CSV import and the editor.
export async function dbFindOrCreateOwner(name, email) {
  const cleanEmail = email.trim().toLowerCase();
  const { data: existing, error: findError } = await supabase
    .from('owners')
    .select('*')
    .eq('email', cleanEmail)
    .maybeSingle();
  if (findError) throw findError;
  if (existing) return existing;

  const { data: created, error: createError } = await supabase
    .from('owners')
    .insert({ name: name.trim(), email: cleanEmail })
    .select()
    .single();
  if (createError) throw createError;
  return created;
}

// Replaces the full set of owners linked to a contract.
export async function dbSetContractOwners(contractId, ownerIds) {
  const { error: deleteError } = await supabase
    .from('contract_owners')
    .delete()
    .eq('contract_id', contractId);
  if (deleteError) throw deleteError;

  if (ownerIds.length === 0) return;

  const rows = ownerIds.map((ownerId) => ({ contract_id: contractId, owner_id: ownerId }));
  const { error: insertError } = await supabase.from('contract_owners').insert(rows);
  if (insertError) throw insertError;
}

// ---------- Categories ----------

export async function dbFetchCategories() {
  const { data, error } = await supabase.from('categories').select('*').order('name');
  if (error) throw error;
  return data;
}

export async function dbUpsertCategory(category) {
  const { data, error } = await supabase
    .from('categories')
    .upsert(category)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function dbDeleteCategory(id) {
  const { error } = await supabase.from('categories').delete().eq('id', id);
  if (error) throw error;
}

// ---------- Alert thresholds ----------

export async function dbFetchAlertThresholds() {
  const { data, error } = await supabase
    .from('alert_thresholds')
    .select('*')
    .order('days_before', { ascending: false });
  if (error) throw error;
  return data;
}

export async function dbUpsertAlertThreshold(threshold) {
  const { data, error } = await supabase
    .from('alert_thresholds')
    .upsert(threshold)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function dbDeleteAlertThreshold(id) {
  const { error } = await supabase.from('alert_thresholds').delete().eq('id', id);
  if (error) throw error;
}

// ---------- User roles (access control) ----------

export async function dbFetchUserRoles() {
  const { data, error } = await supabase.from('user_roles').select('*').order('email');
  if (error) throw error;
  return data;
}

export async function dbUpsertUserRole(userRole) {
  const { data, error } = await supabase
    .from('user_roles')
    .upsert(userRole, { onConflict: 'email' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function dbDeleteUserRole(id) {
  const { error } = await supabase.from('user_roles').delete().eq('id', id);
  if (error) throw error;
}
