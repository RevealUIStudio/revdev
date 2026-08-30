import Button from '../adapters/Button';

interface AgentConnectBannerProps {
  message: string;
  connecting: boolean;
  onConnect: () => void;
}

/** Agent empty-state action: connect here, do not send the operator to Setup. */
export default function AgentConnectBanner({
  message,
  connecting,
  onConnect,
}: AgentConnectBannerProps) {
  return (
    <div className="mb-2 rounded border border-error/40 bg-error-subtle px-2.5 py-2 text-[10px] text-error">
      <p>{message}</p>
      <Button
        type="button"
        variant="primary"
        size="sm"
        className="mt-2"
        onClick={onConnect}
        disabled={connecting}
        loading={connecting}
      >
        Connect Agent
      </Button>
    </div>
  );
}
