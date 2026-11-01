import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_KEY ?? '');

export async function closedToday(): Promise<{ id: string; body: string }[]> {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { data, error } = await supabase.from('tickets').select('id, body').eq('status', 'closed').gte('closed_at', since);
  if (error) throw error;
  return data;
}

export async function saveSummary(id: string, summary: string): Promise<void> {
  const { error } = await supabase.from('tickets').update({ summary }).eq('id', id);
  if (error) throw error;
}
