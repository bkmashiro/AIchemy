import { useEffect, useRef } from "react";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  /** Optional list of items for batch operations (shown as scrollable list) */
  items?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "warning" | "default";
  onConfirm: () => void;
  onCancel: () => void;
}

const VARIANT_STYLES = {
  danger: {
    confirm: "bg-red-600 hover:bg-red-700 text-white",
    icon: "text-red-400",
  },
  warning: {
    confirm: "bg-orange-600 hover:bg-orange-700 text-white",
    icon: "text-orange-400",
  },
  default: {
    confirm: "bg-blue-600 hover:bg-blue-700 text-white",
    icon: "text-blue-400",
  },
};

export default function ConfirmDialog({
  open,
  title,
  message,
  items,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "default",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Focus confirm button when opened; close on Escape
  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  const styles = VARIANT_STYLES[variant];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onCancel}
      />
      {/* Dialog */}
      <div className="relative bg-gray-900 border border-gray-700 rounded-xl shadow-2xl max-w-md w-full mx-4 p-5 space-y-4">
        <h3 className="text-base font-semibold text-white">{title}</h3>
        <p className="text-sm text-gray-400">{message}</p>

        {/* Batch items list */}
        {items && items.length > 0 && (
          <div className="max-h-40 overflow-y-auto bg-gray-950 border border-gray-800 rounded-lg p-2 space-y-0.5">
            {items.map((item, i) => (
              <div key={i} className="text-xs text-gray-400 font-mono truncate px-1 py-0.5">
                {item}
              </div>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            onClick={onCancel}
            className="px-4 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-gray-300 transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className={`px-4 py-1.5 text-sm rounded transition-colors ${styles.confirm}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
