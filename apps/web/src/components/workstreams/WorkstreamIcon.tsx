import {
  WORKSTREAM_COLORS,
  WORKSTREAM_ICONS,
  type WorkstreamColor,
  type WorkstreamIcon as WorkstreamIconName,
} from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import {
  AnchorIcon,
  BookOpenIcon,
  BugIcon,
  CompassIcon,
  DatabaseIcon,
  FlagIcon,
  FlameIcon,
  FlaskConicalIcon,
  GlobeIcon,
  KeyRoundIcon,
  LeafIcon,
  LightbulbIcon,
  MapIcon,
  PackageIcon,
  PuzzleIcon,
  RocketIcon,
  ServerIcon,
  ShieldIcon,
  StarIcon,
  TargetIcon,
  TelescopeIcon,
  TerminalIcon,
  WrenchIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const ICONS: Record<WorkstreamIconName, LucideIcon> = {
  rocket: RocketIcon,
  bug: BugIcon,
  flask: FlaskConicalIcon,
  wrench: WrenchIcon,
  compass: CompassIcon,
  star: StarIcon,
  shield: ShieldIcon,
  database: DatabaseIcon,
  globe: GlobeIcon,
  terminal: TerminalIcon,
  zap: ZapIcon,
  package: PackageIcon,
  map: MapIcon,
  target: TargetIcon,
  book: BookOpenIcon,
  flag: FlagIcon,
  lightbulb: LightbulbIcon,
  puzzle: PuzzleIcon,
  anchor: AnchorIcon,
  leaf: LeafIcon,
  flame: FlameIcon,
  key: KeyRoundIcon,
  telescope: TelescopeIcon,
  server: ServerIcon,
};

const ICON_LABELS: Record<WorkstreamIconName, string> = {
  rocket: msg("Rocket", { $context: "workstream icon name" }),
  bug: msg("Bug", { $context: "workstream icon name" }),
  flask: msg("Flask", { $context: "workstream icon name" }),
  wrench: msg("Wrench", { $context: "workstream icon name" }),
  compass: msg("Compass", { $context: "workstream icon name" }),
  star: msg("Star", { $context: "workstream icon name" }),
  shield: msg("Shield", { $context: "workstream icon name" }),
  database: msg("Database", { $context: "workstream icon name" }),
  globe: msg("Globe", { $context: "workstream icon name" }),
  terminal: msg("Terminal", { $context: "workstream icon name" }),
  zap: msg("Lightning", { $context: "workstream icon name" }),
  package: msg("Package", { $context: "workstream icon name" }),
  map: msg("Map", { $context: "workstream icon name" }),
  target: msg("Target", { $context: "workstream icon name" }),
  book: msg("Book", { $context: "workstream icon name" }),
  flag: msg("Flag", { $context: "workstream icon name" }),
  lightbulb: msg("Lightbulb", { $context: "workstream icon name" }),
  puzzle: msg("Puzzle", { $context: "workstream icon name" }),
  anchor: msg("Anchor", { $context: "workstream icon name" }),
  leaf: msg("Leaf", { $context: "workstream icon name" }),
  flame: msg("Flame", { $context: "workstream icon name" }),
  key: msg("Key", { $context: "workstream icon name" }),
  telescope: msg("Telescope", { $context: "workstream icon name" }),
  server: msg("Server", { $context: "workstream icon name" }),
};

const COLOR_LABELS: Record<WorkstreamColor, string> = {
  red: msg("Red", { $context: "workstream color name" }),
  orange: msg("Orange", { $context: "workstream color name" }),
  amber: msg("Amber", { $context: "workstream color name" }),
  green: msg("Green", { $context: "workstream color name" }),
  teal: msg("Teal", { $context: "workstream color name" }),
  blue: msg("Blue", { $context: "workstream color name" }),
  indigo: msg("Indigo", { $context: "workstream color name" }),
  purple: msg("Purple", { $context: "workstream color name" }),
  pink: msg("Pink", { $context: "workstream color name" }),
  gray: msg("Gray", { $context: "workstream color name" }),
};

const TEXT_CLASS_NAME: Record<WorkstreamColor, string> = {
  red: "text-red-500",
  orange: "text-orange-500",
  amber: "text-amber-500",
  green: "text-emerald-500",
  teal: "text-teal-500",
  blue: "text-blue-500",
  indigo: "text-indigo-500",
  purple: "text-purple-500",
  pink: "text-pink-500",
  gray: "text-zinc-500",
};

const SWATCH_CLASS_NAME: Record<WorkstreamColor, string> = {
  red: "bg-red-500",
  orange: "bg-orange-500",
  amber: "bg-amber-500",
  green: "bg-emerald-500",
  teal: "bg-teal-500",
  blue: "bg-blue-500",
  indigo: "bg-indigo-500",
  purple: "bg-purple-500",
  pink: "bg-pink-500",
  gray: "bg-zinc-500",
};

function WorkstreamIcon(props: {
  icon: WorkstreamIconName;
  color: WorkstreamColor;
  className?: string;
}) {
  const Icon = ICONS[props.icon];
  return (
    <Icon aria-hidden className={cn("shrink-0", TEXT_CLASS_NAME[props.color], props.className)} />
  );
}

const CHOICE_CLASS_NAME =
  "flex size-7 cursor-pointer items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:bg-accent aria-pressed:ring-1 aria-pressed:ring-inset aria-pressed:ring-border";

/** The workstream's marker; when editable, pressing it opens the icon and color choices. */
export function WorkstreamIconPicker(props: {
  name: string;
  icon: WorkstreamIconName;
  color: WorkstreamColor;
  disabled: boolean;
  onChange: (change: { icon?: WorkstreamIconName; color?: WorkstreamColor }) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const [open, setOpen] = useState(false);
  if (props.disabled) {
    return (
      <span className="flex size-6 items-center justify-center">
        <WorkstreamIcon icon={props.icon} color={props.color} className="size-4" />
      </span>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            data-workstream-action=""
            size="icon-xs"
            variant="ghost-muted"
            aria-label={gt("Change the icon of {workstream}", { workstream: props.name })}
          />
        }
      >
        <WorkstreamIcon icon={props.icon} color={props.color} className="size-4" />
      </PopoverTrigger>
      <PopoverPopup align="start" padding="compact" width="sm">
        <div className="flex flex-col gap-3">
          <div role="group" aria-label={gt("Icon")} className="grid grid-cols-8 gap-0.5">
            {WORKSTREAM_ICONS.map((icon) => (
              <button
                key={icon}
                type="button"
                aria-label={m(ICON_LABELS[icon])}
                aria-pressed={icon === props.icon}
                onClick={() => props.onChange({ icon })}
                className={CHOICE_CLASS_NAME}
              >
                <WorkstreamIcon icon={icon} color={props.color} className="size-4" />
              </button>
            ))}
          </div>
          <div role="group" aria-label={gt("Color")} className="flex flex-wrap gap-0.5">
            {WORKSTREAM_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={m(COLOR_LABELS[color])}
                aria-pressed={color === props.color}
                onClick={() => props.onChange({ color })}
                className={CHOICE_CLASS_NAME}
              >
                <span className={cn("size-3.5 rounded-full", SWATCH_CLASS_NAME[color])} />
              </button>
            ))}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
