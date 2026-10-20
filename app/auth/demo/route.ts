// POST /auth/demo {as} (the sign-in page buttons) or GET /auth/demo?as=owner (a link to share):
// signs in as one of the demo accounts (demo mode only).
import { NextResponse, type NextRequest } from 'next/server';
import { DEMO_ACCOUNTS, demoEnabled, isDemoRole } from '@/lib/demo/accounts';
import { createClient } from '@/lib/supabase/server';

export async function POST(request: NextRequest) {
  return signIn(request, (await request.formData()).get('as'));
}

export async function GET(request: NextRequest) {
  return signIn(request, request.nextUrl.searchParams.get('as'));
}

async function signIn(request: NextRequest, role: unknown) {
  const origin = request.nextUrl.origin;
  if (!demoEnabled() || !isDemoRole(role)) return NextResponse.redirect(new URL('/login', origin), { status: 303 });
  const account = DEMO_ACCOUNTS[role];
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email: account.email, password: process.env.DEMO_PASSWORD! });
  if (error) return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(`Demo sign-in failed: ${error.message}`)}`, origin), { status: 303 });
  return NextResponse.redirect(new URL(account.home, origin), { status: 303 });
}
