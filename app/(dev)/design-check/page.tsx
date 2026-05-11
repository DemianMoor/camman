import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { DialogDemo, ToastDemo } from "./interactive";

const tableRows = [
  { id: "BRD-001", name: "Acme Mobile", status: "active", created: "2026-04-12" },
  { id: "BRD-002", name: "Bolt Wireless", status: "active", created: "2026-04-18" },
  { id: "BRD-003", name: "Cypher SMS", status: "archived", created: "2026-03-30" },
];

export default function DesignCheckPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 space-y-10">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Design System Check
        </h1>
        <p className="text-sm text-muted-foreground">
          Visual confirmation that shadcn/ui primitives render correctly.
        </p>
      </header>

      <Separator />

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Buttons</h2>
        <div className="flex flex-wrap items-center gap-3">
          <Button>Default</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="destructive">Destructive</Button>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          Input + Label (in a Card)
        </h2>
        <Card>
          <CardHeader>
            <CardTitle>Brand details</CardTitle>
            <CardDescription>
              Form controls render with consistent spacing and focus styles.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <Label htmlFor="brand-name">Brand name</Label>
            <Input id="brand-name" placeholder="e.g. Acme Mobile" />
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Dialog</h2>
        <DialogDemo />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Badges</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Badge>default</Badge>
          <Badge variant="secondary">secondary</Badge>
          <Badge variant="destructive">destructive</Badge>
          <Badge variant="outline">outline</Badge>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Avatar</h2>
        <Avatar>
          <AvatarImage src="" alt="" />
          <AvatarFallback>DM</AvatarFallback>
        </Avatar>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Toast</h2>
        <ToastDemo />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Table</h2>
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Brand ID</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tableRows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs">{row.id}</TableCell>
                  <TableCell>{row.name}</TableCell>
                  <TableCell>
                    <Badge
                      variant={row.status === "active" ? "secondary" : "outline"}
                    >
                      {row.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {row.created}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </section>
    </main>
  );
}
