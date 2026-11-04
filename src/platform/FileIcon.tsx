/**
 * A file's icon as the Project view draws it: a Java class, interface or enum, a Spring Boot
 * application, a Spring config file… instead of only its file type. Lists of files elsewhere
 * (VCS changes, shelves, pull requests) use it so a file looks the same everywhere.
 */
import { Icon } from "@/ui/icons";
import { useFilePresentation } from "./filePresentation";

/** `path` relative to `root` (a repository) is resolved against it; absolute paths are used as is. */
export function FileIcon({
  path,
  root,
  size = 16,
  className,
}: {
  path: string;
  root?: string | null;
  size?: number;
  className?: string;
}) {
  const absolute = root && !/^([\\/]|[A-Za-z]:)/.test(path) ? `${root.replace(/[\\/]+$/, "")}/${path}` : path;
  const { icon } = useFilePresentation(absolute);
  return <Icon name={icon} size={size} className={className} />;
}
