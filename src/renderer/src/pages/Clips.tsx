import { useNav } from "../nav";
import { LibraryView } from "../components/library/LibraryView";
export { LibraryView as FootageShoot } from "../components/library/LibraryView";
export default function ClipsPage() {
  const { params } = useNav();
  return <LibraryView key={params.shoot ?? ""} root={params.shoot ?? ""} />;
}
