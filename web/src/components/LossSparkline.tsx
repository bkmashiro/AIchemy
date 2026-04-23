interface Props {
  data: number[];
}

export default function LossSparkline({ data }: Props) {
  if (data.length < 2) return null;

  const width = 120;
  const height = 30;
  const pad = 2;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const points = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (v - min) / range) * (height - pad * 2);
    return `${x},${y}`;
  });

  return (
    <svg
      width={width}
      height={height}
      className="inline-block align-middle ml-2"
      viewBox={`0 0 ${width} ${height}`}
    >
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="#60a5fa"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
