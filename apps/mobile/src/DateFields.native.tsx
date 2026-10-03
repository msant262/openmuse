import { View } from "react-native";
import { useI18n } from "./i18n";
import { Field } from "./ui";
export interface DateFieldsProps {
  label: string;
  date: string;
  time: string;
  allDay: boolean;
  onChange: (date: string, time: string) => void;
}
export default function DateFields({ label, date, time, allDay, onChange }: DateFieldsProps) {
  const { t } = useI18n();
  return (
    <View style={{ flexDirection: "row", gap: 12 }}>
      <View style={{ flex: 1.2 }}>
        <Field
          label={t("{label} date", { label })}
          value={date}
          onChangeText={(value) => onChange(value, time)}
          placeholder="YYYY-MM-DD"
          keyboardType="numbers-and-punctuation"
        />
      </View>
      {!allDay && (
        <View style={{ flex: 1 }}>
          <Field
            label={t("{label} time", { label })}
            value={time}
            onChangeText={(value) => onChange(date, value)}
            placeholder={t("HH:MM (24-hour)")}
            keyboardType="numbers-and-punctuation"
          />
        </View>
      )}
    </View>
  );
}
