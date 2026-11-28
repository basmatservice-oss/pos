import type { ReactNode } from 'react';

type LineagePageHeaderProps = {
  title: string;
  description?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
};

export default function LineagePageHeader({
  title,
  description,
  icon,
  actions,
  className = '',
}: LineagePageHeaderProps) {
  return (
    <header className={`lineage-page-header ${className}`} dir="rtl">
      <div className="lineage-page-header__identity">
        {icon && <span className="lineage-page-header__icon" aria-hidden="true">{icon}</span>}
        <div className="min-w-0">
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
      </div>
      {actions && <div className="lineage-page-header__actions">{actions}</div>}
    </header>
  );
}
