export function formatTime(timestamp: number | string | Date): string {
  const date = new Date(typeof timestamp === 'number' && timestamp < 1e12 ? timestamp * 1000 : timestamp);
  return date.toLocaleString('vi-VN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatLastSeen(timestamp: number | string | Date | null | undefined): string {
  if (!timestamp) return 'Never active';
  const date = new Date(typeof timestamp === 'number' && timestamp < 1e12 ? timestamp * 1000 : timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) {
    return 'Active just now';
  } else if (diffMin < 60) {
    return `${diffMin}m ago`;
  } else if (diffHour < 24) {
    return `${diffHour}h ago`;
  } else if (diffDay === 1) {
    return 'Yesterday';
  } else if (diffDay < 7) {
    return `${diffDay}d ago`;
  } else {
    return `Active on ${date.toLocaleDateString('en-US')} at ${date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
  }
}
