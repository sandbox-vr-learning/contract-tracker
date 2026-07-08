// Supabase client — safe to expose the anon key client-side, RLS enforces access.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://xgfgqkildruxruudofyk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhnZmdxa2lsZHJ1eHJ1dWRvZnlrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MzAxOTEsImV4cCI6MjA5OTEwNjE5MX0.P5mXcM0eXjBJ0BB0_UfMkfe98u-bYjR6CzoEjwN4oCM';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
