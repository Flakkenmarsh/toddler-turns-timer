import { createFileRoute } from "@tanstack/react-router";
import { PhotoTimer } from "@/components/PhotoTimer";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  return <PhotoTimer />;
}