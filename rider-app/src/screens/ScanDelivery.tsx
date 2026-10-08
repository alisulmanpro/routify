import { Screen } from '../components/Kit';
import DeliveryWizard from '../components/DeliveryWizard';
import { premium as c } from '../lib/theme';
import { useNav } from '../lib/nav';

/** Camera entry: address, then parcel ID, then the optional details, one step at a time. */
export default function ScanDelivery({ onCreated }: { onCreated: () => void }) {
  const { goBack } = useNav();
  return (
    <Screen style={{ backgroundColor: c.background }}>
      <DeliveryWizard mode="scan" onCreated={onCreated} onDone={goBack} />
    </Screen>
  );
}
