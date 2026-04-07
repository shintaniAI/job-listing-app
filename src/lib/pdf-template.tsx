import React from "react";
import path from "path";
import { Document, Page, Text, View, StyleSheet, Font } from "@react-pdf/renderer";

// Register Japanese font from local filesystem (bundled in public/fonts).
// Using remote CDN + .woff caused the PDF generation to hang on Vercel.
const fontDir = path.join(process.cwd(), "public", "fonts");
Font.register({
  family: "NotoSansJP",
  fonts: [
    { src: path.join(fontDir, "NotoSansJP-Regular.ttf"), fontWeight: 400 },
    { src: path.join(fontDir, "NotoSansJP-Bold.ttf"), fontWeight: 700 },
  ],
});

// Disable hyphenation (react-pdf default can break CJK text awkwardly).
Font.registerHyphenationCallback((word) => [word]);

const styles = StyleSheet.create({
  page: {
    padding: 40,
    fontFamily: "NotoSansJP",
    fontSize: 10,
    color: "#333",
  },
  header: {
    backgroundColor: "#1e40af",
    color: "#fff",
    padding: 16,
    marginBottom: 20,
    borderRadius: 4,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 700,
    marginBottom: 4,
  },
  headerSub: {
    fontSize: 11,
    opacity: 0.9,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: 700,
    color: "#1e40af",
    borderBottomWidth: 2,
    borderBottomColor: "#1e40af",
    paddingBottom: 4,
    marginBottom: 8,
    marginTop: 16,
  },
  table: { marginBottom: 8 },
  row: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
    minHeight: 28,
  },
  labelCell: {
    width: "25%",
    backgroundColor: "#f3f4f6",
    padding: 6,
    fontWeight: 700,
    fontSize: 9,
    color: "#4b5563",
  },
  valueCell: {
    width: "75%",
    padding: 6,
    fontSize: 9,
    lineHeight: 1.5,
  },
  footer: {
    position: "absolute",
    bottom: 30,
    left: 40,
    right: 40,
    textAlign: "center",
    fontSize: 8,
    color: "#9ca3af",
  },
});

function TableSection({ title, rows }: { title: string; rows?: Record<string, string> }) {
  if (!rows || Object.keys(rows).length === 0) return null;
  return (
    <View>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.table}>
        {Object.entries(rows).map(([key, val]) => (
          <View style={styles.row} key={key}>
            <Text style={styles.labelCell}>{key}</Text>
            <Text style={styles.valueCell}>{val || "—"}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

export function JobPdfDocument({ data }: { data: any }) {
  const title = [data.companyName, data.jobTitle].filter(Boolean).join(" - ") || "求人票";
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>{title}</Text>
          {data.summary ? <Text style={styles.headerSub}>{data.summary}</Text> : null}
        </View>

        <TableSection title="募集概要" rows={data.overview} />
        <TableSection title="仕事内容" rows={data.jobContent} />
        <TableSection title="募集要項" rows={data.requirements} />
        <TableSection title="仕事環境" rows={data.environment} />

        <Text style={styles.footer}>
          この求人票はAIにより自動生成されました。内容は参考情報です。
        </Text>
      </Page>
    </Document>
  );
}
