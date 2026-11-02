-- Reconcile the original 007_commerce.sql database safeguard with the
-- existing API's narrower 2026 policy: immutable OLD active units/expiry, but
-- allow activating never-used unit slots once EACH batch/location is zero.
-- No item values, stock movements, journals or history are rewritten.
CREATE OR REPLACE FUNCTION protect_item_stock_units()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.unit1_name,NEW.unit2_name,NEW.unit3_name,NEW.factor2,NEW.factor3,NEW.has_expiry)
     IS NOT DISTINCT FROM
     ROW(OLD.unit1_name,OLD.unit2_name,OLD.unit3_name,OLD.factor2,OLD.factor3,OLD.has_expiry)
  THEN
    RETURN NEW;
  END IF;

  -- Fresh items have no operational history; existing item schema constraints
  -- still validate enabled unit names and factors.
  IF NOT EXISTS (
    SELECT 1 FROM stock_movements
    WHERE company_id=OLD.company_id AND item_id=OLD.id
  ) THEN
    RETURN NEW;
  END IF;

  -- Historical invoice/stock snapshots must never be reinterpreted.
  IF OLD.unit1_name IS DISTINCT FROM NEW.unit1_name
     OR OLD.has_expiry IS DISTINCT FROM NEW.has_expiry
     OR (OLD.factor2 > 1 AND
         (OLD.factor2 IS DISTINCT FROM NEW.factor2
           OR OLD.unit2_name IS DISTINCT FROM NEW.unit2_name))
     OR (OLD.factor3 > 1 AND
         (OLD.factor3 IS DISTINCT FROM NEW.factor3
           OR OLD.unit3_name IS DISTINCT FROM NEW.unit3_name))
     OR (NEW.factor3 > 1 AND NEW.factor2 <= 1)
     OR (OLD.factor3 > 1 AND OLD.factor2 <= 1 AND NEW.factor2 > 1)
     OR (NEW.factor2 > 1 AND length(btrim(NEW.unit2_name)) = 0)
     OR (NEW.factor3 > 1 AND length(btrim(NEW.unit3_name)) = 0)
  THEN
    RAISE EXCEPTION 'Operational item units and expiry cannot be reinterpreted'
      USING ERRCODE='23514';
  END IF;

  -- A zero company total can conceal an offsetting positive/negative batch:
  -- both sides must actually be zero, including return warehouses.
  IF EXISTS (
    SELECT 1 FROM stock_balances
    WHERE company_id=OLD.company_id AND item_id=OLD.id
      AND quantity_smallest<>0
  ) THEN
    RAISE EXCEPTION 'New item units require zero stock in every location and batch'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

-- Record the precise cause in the site's developer guide.
INSERT INTO explanation_nodes
  (group_id,parent_id,position,kind,title,body,import_key)
SELECT g.id,NULL,
  COALESCE((SELECT max(n.position) FROM explanation_nodes n
    WHERE n.group_id=g.id AND n.parent_id IS NULL),0)+1,
  'heading',
  'تصحيح مانع قاعدة البيانات لإضافة وحدة جديدة بعد حركات سابقة وصفر جميع الدفعات (2 نوفمبر 2026)',
  'سبب رفض وحدة ثانية جديدة للصنف 00015180 (السجل 15182) في دار الدواء بعد صفر المخزون: بالإضافة إلى مشكلة حفظ اسم الوحدة ومعاملها في طلبين منفصلين، وُجد منع قديم على مستوى PostgreSQL في migration 007_commerce.sql: الدالة protect_item_stock_units المرتبطة بالمشغل items_stock_units كانت ترفض أي تغيير في اسم الوحدة أو معاملها عند وجود أي حركة stock_movements، وتظهر في سجلات Render العبارة Operational item units and expiry cannot be reinterpreted. بينما الخادم routes-items.ts خفف السياسة سابقاً بإجازة فقط إضافة خانة وحدة غير مفعلة عند صفر جميع دفعات المخزون، وفق addsOnlyPreviouslyInactiveUnits. التصحيح الآمن في migration 20261102_allow_unused_units_at_zero.sql: استبدال الدالة PostgreSQL بـ CREATE OR REPLACE FUNCTION للاحتفاظ بمنع تغيير اسم الوحدة الأولى أو تتبع الانتهاء أو أي اسم/معامل لوحدة فعالة تاريخياً أو تفعيل ثالثة دون ثانية، وفي الوقت نفسه السماح بكتابة اسم/معامل وحدة ثانية أو ثالثة كانت غير مفعلة فقط إذا كانت كل صفوف stock_balances.quantity_smallest صفراً في كل المخازن والمعارض والدفعات. لا تكتف بصفر إجمالي الشركة لأن الموجب والسالب المتعاكس يخدعان الإجمالي. لا تغيّر بيانات الصنف الفعلية ولا المخزون أو تاريخ الحركات ولا قيود المحاسبة، ولا تعطل مشغلات الحماية الأصلية؛ فقط يصحح شرط الحماية. يظل التحقق السابق في API مزدوجاً مع trigger، وإضافة وحدة بزوج تغييرات واحد من الواجهة في PR #322. اختبار التكامل يجب أن ينشئ حركات حقيقية ثم يصفر الرصيد ويفعل وحدة خاملة ويتأكد بقاء لقطات الحركات التاريخية دون مساس، وأن تغيير وحدة قديمة أو محاولة الإضافة قبل تصفيرها يرفض. إذا ظهرت رسالة رفض أخرى بعد هذا التعديل، راجع API وسجل Render ولا تختلق نجاحاً.',
  'developer-db-inactive-unit-trigger-zero-stock-20261102'
FROM explanation_groups g WHERE g.slug='site-developer-guide'
ON CONFLICT(import_key) DO NOTHING;
