import React, { useEffect, useState } from 'react';
import { AlertTriangle, HelpCircle, X } from 'lucide-react';

interface ConfirmationModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'primary' | 'danger';
  promptLabel?: string;
  promptPlaceholder?: string;
  promptRequired?: boolean;
  initialPromptValue?: string;
  onConfirm: (inputValue?: string) => void;
  onCancel: () => void;
}

const ConfirmationModal: React.FC<ConfirmationModalProps> = ({
  isOpen,
  title,
  message,
  confirmLabel = 'تأكيد',
  cancelLabel = 'إلغاء',
  variant = 'primary',
  promptLabel,
  promptPlaceholder,
  promptRequired = false,
  initialPromptValue = '',
  onConfirm,
  onCancel,
}) => {
  const [inputValue, setInputValue] = useState(initialPromptValue);

  useEffect(() => {
    if (isOpen) setInputValue(initialPromptValue);
  }, [isOpen, initialPromptValue]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  const isDanger = variant === 'danger';
  const canConfirm = !promptLabel || !promptRequired || inputValue.trim().length > 0;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (canConfirm) onConfirm(promptLabel ? inputValue.trim() : undefined);
  };

  return (
    <div
      className="lineage-dialog-backdrop fixed inset-0 z-[100] bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4"
      dir="rtl"
      onClick={onCancel}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirmation-modal-title"
        aria-describedby="confirmation-modal-message"
        className="lineage-dialog-panel bg-white w-full max-w-md rounded-2xl border border-slate-200 shadow-2xl p-6"
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 border ${isDanger
              ? 'bg-rose-50 text-rose-600 border-rose-200'
              : 'bg-indigo-50 text-indigo-600 border-indigo-200'}`}>
              {isDanger ? <AlertTriangle className="w-5 h-5" /> : <HelpCircle className="w-5 h-5" />}
            </div>
            <h3 id="confirmation-modal-title" className="text-lg font-bold text-slate-900 leading-snug">{title}</h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="lineage-dialog-close p-2 rounded-full text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors shrink-0"
            aria-label="إغلاق"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p id="confirmation-modal-message" className="text-sm text-slate-600 leading-7 mb-5">{message}</p>

        {promptLabel && (
          <div className="mb-5">
            <label htmlFor="confirmation-modal-input" className="block text-sm font-semibold text-slate-700 mb-2">
              {promptLabel} {promptRequired && <span className="text-rose-500">*</span>}
            </label>
            <input
              id="confirmation-modal-input"
              type="text"
              autoFocus
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              placeholder={promptPlaceholder || ''}
              required={promptRequired}
              className="lineage-dialog-input w-full min-h-12 px-4 py-3 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white"
            />
          </div>
        )}

        <div className="lineage-dialog-actions flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="min-h-12 px-5 py-3 rounded-full border border-slate-200 bg-white text-slate-700 text-sm font-bold hover:bg-slate-50 transition-colors whitespace-nowrap"
          >
            {cancelLabel}
          </button>
          <button
            type="submit"
            disabled={!canConfirm}
            className={`min-h-12 px-6 py-3 rounded-full text-white text-sm font-bold transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed ${isDanger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
};

export default ConfirmationModal;
