import { IconLock, IconPlus } from '@revealui/presentation';
import { useState } from 'react';
import { useVault } from '../../hooks/use-vault';
import Button from '../adapters/Button';
import ErrorAlert from '../adapters/ErrorAlert';
import CreateSecretDialog from './CreateSecretDialog';
import NamespaceFilter from './NamespaceFilter';
import SearchBar from './SearchBar';
import SecretDetail from './SecretDetail';
import SecretList from './SecretList';

export default function VaultPanel() {
  const {
    initialized,
    secrets,
    selectedPath,
    selectedValue,
    loading,
    valueLoading,
    error,
    searchQuery,
    activeNamespace,
    namespaces,
    initStore,
    selectSecret,
    createSecret,
    deleteSecret,
    setSearchQuery,
    setActiveNamespace,
  } = useVault();

  const [showCreate, setShowCreate] = useState(false);

  if (loading) {
    return <VaultSkeleton />;
  }

  if (!initialized) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <div className="flex size-12 items-center justify-center rounded-xl bg-surface-2">
          <IconLock size="lg" className="text-fg-muted" />
        </div>
        <div className="text-center">
          <h3 className="text-base font-semibold text-fg">Vault not initialized</h3>
          <p className="mt-1 text-sm text-fg-subtle">
            Initialize the passage-store to start managing secrets
          </p>
        </div>
        <ErrorAlert message={error} className="max-w-sm text-center" />
        <Button variant="primary" size="lg" onClick={initStore}>
          Initialize Vault
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <SearchBar query={searchQuery} onChange={setSearchQuery} />
        </div>
        <Button variant="primary" onClick={() => setShowCreate(true)}>
          <IconPlus size="sm" className="mr-1.5" />
          New Secret
        </Button>
      </div>

      <ErrorAlert message={error} />

      {/* Three-column layout: Namespace | List | Detail */}
      <div className="flex flex-1 gap-0 overflow-hidden rounded-lg border border-edge bg-surface-0/30">
        <div className="w-44 flex-shrink-0 border-r border-edge p-3">
          <NamespaceFilter
            namespaces={namespaces}
            active={activeNamespace}
            onChange={setActiveNamespace}
          />
        </div>

        <div className="flex w-64 flex-shrink-0 flex-col border-r border-edge p-3">
          <SecretList
            secrets={secrets}
            selectedPath={selectedPath}
            onSelect={selectSecret}
            onDelete={deleteSecret}
          />
        </div>

        <SecretDetail path={selectedPath} value={selectedValue} loading={valueLoading} />
      </div>

      {showCreate && (
        <CreateSecretDialog onConfirm={createSecret} onClose={() => setShowCreate(false)} />
      )}
    </div>
  );
}

function VaultSkeleton() {
  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center gap-3">
        <div className="h-9 flex-1 animate-pulse rounded-md bg-surface-2" />
        <div className="h-9 w-28 animate-pulse rounded-md bg-surface-2" />
      </div>
      <div className="flex flex-1 overflow-hidden rounded-lg border border-edge bg-surface-0/30">
        <div className="w-44 border-r border-edge p-3">
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-7 animate-pulse rounded bg-surface-3" />
            ))}
          </div>
        </div>
        <div className="w-64 border-r border-edge p-3">
          <div className="space-y-2">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded bg-surface-3" />
            ))}
          </div>
        </div>
        <div className="flex-1" />
      </div>
    </div>
  );
}
