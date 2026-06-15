import Link from "next/link";

export function SeasonNav({
  seasons,
  current,
  basePath,
}: {
  seasons: string[];
  current: string;
  basePath: string;
}) {
  return (
    <div className="seasonnav">
      {seasons.map((s) => (
        <Link key={s} href={`${basePath}?season=${s}`} className={s === current ? "active" : ""}>
          {s}年
        </Link>
      ))}
    </div>
  );
}
