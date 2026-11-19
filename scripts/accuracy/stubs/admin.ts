// Stand-in for lib/supabase/admin.ts when scripts/accuracy/render-stored.ts renders the customer
// quote pages outside Next.js: a client that answers the quote lookup with the row the script put
// in globalThis.__storedQuoteRow__, writes nothing, and answers every other call with no rows.
type Result = { data: unknown; error: null };

function builder(table: string): unknown {
  let single = false;
  let isSelect = false;
  const result = (): Result => {
    const row = table === 'quotes' && isSelect ? ((globalThis as { __storedQuoteRow__?: unknown }).__storedQuoteRow__ ?? null) : null;
    return { data: single ? row : row ? [row] : [], error: null };
  };
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (r: Result) => void) => resolve(result());
        return () => {
          if (prop === 'select') isSelect = true;
          if (prop === 'update' || prop === 'insert' || prop === 'upsert' || prop === 'delete') isSelect = false;
          if (prop === 'maybeSingle' || prop === 'single') single = true;
          return proxy;
        };
      },
    },
  );
  return proxy;
}

export function createAdminClient() {
  return { from: (table: string) => builder(table), storage: { from: () => builder('storage') } };
}
