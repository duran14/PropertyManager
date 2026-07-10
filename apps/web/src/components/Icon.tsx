/**
 * Catálogo central de iconos.
 *
 * Usamos lucide-react: iconos SVG estilizados. Cada concepto lleva un color
 * semántico asignado (no colores al azar) con clases Tailwind de "soft badge"
 * — fondo tenue + icono del mismo tono — para verse coloridos pero formales.
 *
 * Centralizar aquí asegura consistencia: el icono de "factura" siempre es
 * el mismo y del mismo color en toda la app.
 */
import {
  LayoutDashboard,
  ReceiptText,
  Scale,
  ShieldCheck,
  Home,
  Bot,
  Brain,
  Paperclip,
  Target,
  UserCheck,
  BookOpen,
  Upload,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  RefreshCw,
  FileText,
  Sparkles,
  MessageCircle,
  Users,
  Cpu,
  Banknote,
  FileSignature,
  CalendarClock,
  CalendarDays,
  type LucideIcon,
} from 'lucide-react';
import type { ComponentProps } from 'react';

export type IconName =
  | 'dashboard'
  | 'bills'
  | 'reconciliation'
  | 'audit'
  | 'home'
  | 'ai'
  | 'ocr'
  | 'receipt'
  | 'confidence'
  | 'hitl'
  | 'qbo'
  | 'upload'
  | 'approve'
  | 'reject'
  | 'pending'
  | 'warning'
  | 'refresh'
  | 'document'
  | 'sparkles'
  | 'chat'
  | 'leads'
  | 'sentinel'
  | 'etransfer'
  | 'rta'
  | 'schedule'
  | 'showings';

/** Color semántico por concepto: clases de fondo tenue + texto del tono. */
export interface IconColor {
  badge: string; // contenedor: fondo suave
  text: string; // icono: tono principal
}

export const ICON_COLORS: Record<IconName, IconColor> = {
  // Navegación / estructura — brand (azul)
  dashboard: { badge: 'bg-blue-50', text: 'text-blue-600' },
  home: { badge: 'bg-blue-50', text: 'text-blue-600' },

  // Bills - indigo
  bills: { badge: 'bg-indigo-50', text: 'text-indigo-600' },
  receipt: { badge: 'bg-indigo-50', text: 'text-indigo-600' },

  // Reconciliation - teal
  reconciliation: { badge: 'bg-teal-50', text: 'text-teal-600' },

  // Auditoría — esmeralda
  audit: { badge: 'bg-emerald-50', text: 'text-emerald-600' },

  // IA / OCR — violeta (destino para la pieza de IA)
  ai: { badge: 'bg-violet-50', text: 'text-violet-600' },
  ocr: { badge: 'bg-violet-50', text: 'text-violet-600' },

  // Recibo adjunto — sky
  confidence: { badge: 'bg-amber-50', text: 'text-amber-600' },

  // HITL — rosa
  hitl: { badge: 'bg-rose-50', text: 'text-rose-600' },

  // QuickBooks — cyan
  qbo: { badge: 'bg-cyan-50', text: 'text-cyan-600' },

  // Actions
  upload: { badge: 'bg-blue-50', text: 'text-blue-600' },
  approve: { badge: 'bg-green-50', text: 'text-green-600' },
  reject: { badge: 'bg-red-50', text: 'text-red-600' },
  pending: { badge: 'bg-amber-50', text: 'text-amber-600' },
  warning: { badge: 'bg-amber-50', text: 'text-amber-600' },
  refresh: { badge: 'bg-teal-50', text: 'text-teal-600' },
  document: { badge: 'bg-slate-100', text: 'text-slate-600' },
  sparkles: { badge: 'bg-violet-50', text: 'text-violet-600' },
  chat: { badge: 'bg-green-50', text: 'text-green-600' },
  leads: { badge: 'bg-amber-50', text: 'text-amber-600' },
  sentinel: { badge: 'bg-violet-50', text: 'text-violet-600' },
  etransfer: { badge: 'bg-teal-50', text: 'text-teal-600' },
  rta: { badge: 'bg-rose-50', text: 'text-rose-600' },
  schedule: { badge: 'bg-indigo-50', text: 'text-indigo-600' },
  showings: { badge: 'bg-teal-50', text: 'text-teal-600' },
};

const ICONS: Record<IconName, LucideIcon> = {
  dashboard: LayoutDashboard,
  bills: ReceiptText,
  reconciliation: Scale,
  audit: ShieldCheck,
  home: Home,
  ai: Bot,
  ocr: Bot,
  receipt: Paperclip,
  confidence: Target,
  hitl: UserCheck,
  qbo: BookOpen,
  upload: Upload,
  approve: CheckCircle2,
  reject: XCircle,
  pending: Clock,
  warning: AlertTriangle,
  refresh: RefreshCw,
  document: FileText,
  sparkles: Sparkles,
  chat: MessageCircle,
  leads: Users,
  sentinel: Cpu,
  etransfer: Banknote,
  rta: FileSignature,
  schedule: CalendarClock,
  showings: CalendarDays,
};

interface IconProps extends ComponentProps<'svg'> {
  name: IconName;
  size?: number;
}

/** Icono puro (sin contenedor). Hereda color de la clase que le pases. */
export function Icon({ name, size = 20, className, ...rest }: IconProps) {
  const Cmp = ICONS[name];
  return <Cmp size={size} strokeWidth={1.75} className={className} aria-hidden {...rest} />;
}

interface IconBadgeProps {
  name: IconName;
  size?: number;
  badgeSize?: number; // tamaño del contenedor cuadrado
  className?: string;
}

/**
 * Icono dentro de un "soft badge": fondo tenue del color semántico + icono
 * del mismo tono. Es el componente que da el look colorido pero formal.
 */
export function IconBadge({ name, size = 20, badgeSize = 40, className = '' }: IconBadgeProps) {
  const color = ICON_COLORS[name];
  return (
    <span
      className={`inline-flex items-center justify-center rounded-xl ${color.badge} ${className}`}
      style={{ width: badgeSize, height: badgeSize }}
    >
      <Icon name={name} size={size} className={color.text} />
    </span>
  );
}

// Re-export para uso avanzado (combinaciones como robot+cerebro).
export { Bot, Brain, Bot as Robot };
