/* shadcn-style primitives on Radix, styled with the app's tokens */
import * as TooltipP from "@radix-ui/react-tooltip";
import * as HoverCardP from "@radix-ui/react-hover-card";
import * as DropdownP from "@radix-ui/react-dropdown-menu";
import * as CheckboxP from "@radix-ui/react-checkbox";
import * as ToggleGroupP from "@radix-ui/react-toggle-group";
import { Check } from "lucide-react";
import { forwardRef } from "react";
import { cn } from "./lib";

export const Button = forwardRef(function Button({ variant = "outline", size = "md", className, ...p }, ref) {
  const v = {
    primary: "bg-hilite text-on-hilite font-semibold hover:brightness-[1.04] border-transparent shadow-[0_1px_0_rgb(255_255_255/0.45)_inset,0_1px_2px_rgb(0_0_0/0.18)]",
    outline: "bg-surface text-ink border-line-2 hover:bg-subtle",
    ghost: "bg-transparent text-ink-2 border-transparent hover:bg-subtle hover:text-ink",
    soft: "bg-subtle text-ink border-transparent hover:bg-muted",
  }[variant];
  const s = { sm: "h-7 px-2.5 text-[12.5px] gap-1.5 rounded-md", md: "h-8.5 px-3 text-[13.5px] gap-2 rounded-lg", lg: "h-10 px-4 text-sm gap-2 rounded-lg", icon: "h-8 w-8 justify-center rounded-lg", iconSm: "h-7 w-7 justify-center rounded-md" }[size];
  return <button ref={ref} className={cn("inline-flex items-center border font-medium whitespace-nowrap transition-colors disabled:opacity-50 disabled:pointer-events-none cursor-pointer select-none", v, s, className)} {...p} />;
});

export function Badge({ tone = "neutral", dot, className, children }) {
  const t = {
    neutral: "bg-subtle text-ink-2 border-line",
    bid: "bg-bid-soft text-bid border-transparent",
    nobid: "bg-nobid-soft text-nobid border-transparent",
    warn: "bg-warn-soft text-warn border-transparent",
    info: "bg-info-soft text-info border-transparent",
    accent: "bg-accent-soft text-accent border-transparent",
    outline: "bg-transparent text-ink-2 border-line-2",
  }[tone];
  return (
    <span className={cn("inline-flex items-center gap-1.5 h-5.5 px-2 rounded-full border text-[11.5px] font-semibold whitespace-nowrap", t, className)}>
      {dot && <span className="w-1.5 h-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export const Card = ({ className, ...p }) => <section className={cn("bg-surface border border-line rounded-xl shadow-card", className)} {...p} />;
export const CardHead = ({ title, sub, right, className }) => (
  <div className={cn("flex items-center justify-between gap-3 px-4.5 py-3 border-b border-line", className)}>
    <div className="min-w-0"><h2 className="text-[14px] font-semibold tracking-[-0.01em] text-ink">{title}</h2>{sub && <p className="text-[12.5px] text-ink-3 mt-0.5">{sub}</p>}</div>
    {right}
  </div>
);
export const Kbd = ({ children }) => <kbd className="font-mono text-[10.5px] text-ink-3 border border-line rounded px-1.5 py-px bg-surface">{children}</kbd>;

export function Tip({ content, children, side = "top" }) {
  return (
    <TooltipP.Root delayDuration={250}>
      <TooltipP.Trigger asChild>{children}</TooltipP.Trigger>
      <TooltipP.Portal>
        <TooltipP.Content side={side} sideOffset={6} className="z-50 max-w-72 rounded-md bg-ink text-bg text-[12px] leading-snug px-2.5 py-1.5 shadow-pop data-[state=delayed-open]:animate-in">
          {content}
        </TooltipP.Content>
      </TooltipP.Portal>
    </TooltipP.Root>
  );
}
export const TipProvider = TooltipP.Provider;

export function Hover({ content, children }) {
  return (
    <HoverCardP.Root openDelay={280} closeDelay={80}>
      <HoverCardP.Trigger asChild>{children}</HoverCardP.Trigger>
      <HoverCardP.Portal>
        <HoverCardP.Content sideOffset={8} collisionPadding={12} className="z-50 w-[340px] rounded-xl border border-line bg-surface p-3.5 shadow-pop">
          {content}
        </HoverCardP.Content>
      </HoverCardP.Portal>
    </HoverCardP.Root>
  );
}

export const Menu = DropdownP.Root;
export const MenuTrigger = DropdownP.Trigger;
export function MenuContent({ children }) {
  return (
    <DropdownP.Portal>
      <DropdownP.Content align="end" sideOffset={6} className="z-50 min-w-[210px] rounded-xl border border-line bg-surface p-1 shadow-pop">{children}</DropdownP.Content>
    </DropdownP.Portal>
  );
}
export const MenuItem = ({ className, ...p }) => <DropdownP.Item className={cn("flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-ink-2 outline-none cursor-pointer data-[highlighted]:bg-subtle data-[highlighted]:text-ink", className)} {...p} />;
export const MenuSep = () => <DropdownP.Separator className="my-1 h-px bg-line" />;

export function Checkbox({ checked, onCheckedChange, label }) {
  return (
    <CheckboxP.Root checked={checked} onCheckedChange={onCheckedChange} aria-label={label} className="mt-0.5 h-4.5 w-4.5 shrink-0 rounded-[5px] border border-line-2 bg-surface data-[state=checked]:bg-hilite data-[state=checked]:border-hilite grid place-items-center cursor-pointer">
      <CheckboxP.Indicator><Check className="h-3 w-3 text-on-hilite" strokeWidth={3} /></CheckboxP.Indicator>
    </CheckboxP.Root>
  );
}

export function Segmented({ value, onChange, items, label }) {
  return (
    <ToggleGroupP.Root type="single" value={value} onValueChange={(v) => v && onChange(v)} aria-label={label} className="inline-flex p-0.5 rounded-lg bg-subtle border border-line">
      {items.map((it) => (
        <ToggleGroupP.Item key={it.value} value={it.value} className="h-7 px-2.5 rounded-md text-[12.5px] font-medium text-ink-2 data-[state=on]:bg-surface data-[state=on]:text-ink data-[state=on]:shadow-card cursor-pointer inline-flex items-center gap-1.5">
          {it.label}{it.count != null && <span className="tnum text-ink-3 font-normal">{it.count}</span>}
        </ToggleGroupP.Item>
      ))}
    </ToggleGroupP.Root>
  );
}
