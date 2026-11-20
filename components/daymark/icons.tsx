// Daymark icons: Lucide (ISC licence), drawn with a thicker stroke for sun glare. Icons always come
// with a word, except in 48px icon buttons, which carry an aria-label. Never use emoji as icons.
//
//   <Icon icon={Satellite} />            24px, stroke 2.25 (default)
//   <Icon icon={Check} size="s" />       18px, stroke 2.5 (inside tags and small text)
//   <Icon icon={House} size="l" />       28px
//   <Icon icon={Info} label="Info" />    meaningful on its own: gets role="img" and a name
import type { LucideIcon, LucideProps } from 'lucide-react';

export type { LucideIcon } from 'lucide-react';

const SIZES = { xs: [16, 2.6], s: [18, 2.5], m: [24, 2.25], l: [28, 2.25], xl: [44, 2] } as const;
export type IconSize = keyof typeof SIZES;

export function Icon({
  icon: Glyph,
  size = 'm',
  label,
  className,
  ...rest
}: Omit<LucideProps, 'size' | 'ref'> & { icon: LucideIcon; size?: IconSize; label?: string }) {
  const [px, stroke] = SIZES[size];
  return (
    <Glyph
      width={px}
      height={px}
      strokeWidth={stroke}
      absoluteStrokeWidth={false}
      className={className ? `shrink-0 ${className}` : 'shrink-0'}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      focusable="false"
      {...rest}
    />
  );
}

// The set the app uses, re-exported so screens import icons from one place.
export {
  ArrowLeft,
  ArrowRight,
  Ban,
  Briefcase,
  Calendar,
  CalendarCheck,
  CalendarPlus,
  Camera,
  ChartColumn,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleHelp,
  CircleX,
  ClipboardCheck,
  Clock,
  CloudAlert,
  CloudCheck,
  CloudOff,
  CloudUpload,
  Compass,
  Contrast,
  Copy,
  Delete,
  Download,
  Ellipsis,
  Eye,
  FilePenLine,
  FileText,
  Files,
  Globe,
  Hammer,
  House,
  HousePlus,
  Image,
  Images,
  Info,
  KeyRound,
  LayoutDashboard,
  LifeBuoy,
  ListChecks,
  LoaderCircle,
  Lock,
  LogOut,
  Mail,
  MessageSquareText,
  MapPin,
  Menu,
  Minus,
  Moon,
  OctagonAlert,
  Palette,
  PencilLine,
  Phone,
  Plus,
  Pointer,
  Printer,
  RefreshCw,
  Ruler,
  Satellite,
  ScanLine,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Signature,
  Smartphone,
  Sparkles,
  Star,
  Sun,
  ThumbsDown,
  Trash2,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  Truck,
  Undo2,
  User,
  Users,
  WifiOff,
  Wind,
  Wrench,
  X,
} from 'lucide-react';
